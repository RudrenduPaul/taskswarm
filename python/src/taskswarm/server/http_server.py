"""The TaskSwarm HTTP+SSE server: POST /events ingests a status transition,
GET /events lists current session state, GET /live streams new events over
Server-Sent Events, and GET / serves the live status page. Ported from
src/server/http-server.ts.

Uses only the standard library (`http.server.ThreadingHTTPServer`) -- one
thread per connection, which is what makes a long-lived GET /live SSE
connection sit in its own thread without blocking any other request. This
mirrors Node's single-process-many-connections model closely enough for a
tool meant to run on a developer's own machine, not at scale.
"""
from __future__ import annotations

import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from ..notifications.dispatch import NotifyOptions, notify
from ..schema.events import EventValidationError, parse_agent_event_input, to_agent_event
from .auth import extract_bearer_token, tokens_match
from .event_store import EventStore

# 64KiB is generous for a single event envelope.
MAX_BODY_BYTES = 64 * 1024

_UI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ui")

# SSE clients that get a heartbeat comment (never real data) if nothing
# arrives for this long, so a dead TCP connection is noticed and cleaned up
# instead of the serving thread blocking on it forever.
_SSE_HEARTBEAT_SECONDS = 15.0

# Caps concurrent /live SSE connections (each holds its own OS thread here,
# since ThreadingHTTPServer is one-thread-per-connection) so a client
# (malicious or just leaked-token) can't exhaust server threads/FDs by
# opening unbounded long-lived connections.
_MAX_SSE_CLIENTS = 64


class TaskSwarmHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    store: EventStore
    token: str
    notify_options: NotifyOptions
    sse_clients: "set[queue.Queue]"
    sse_lock: threading.Lock


def _send_json(handler: BaseHTTPRequestHandler, status: int, body: Any) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    try:
        handler.wfile.write(payload)
    except (BrokenPipeError, ConnectionResetError):
        pass


def _is_authorized(
    handler: BaseHTTPRequestHandler, token: str, query: Dict[str, list], allow_query_token: bool
) -> bool:
    header_token = extract_bearer_token(handler.headers.get("Authorization"))
    if header_token and tokens_match(header_token, token):
        return True
    # SSE clients (EventSource) cannot set custom headers, so /live -- and
    # only /live -- also accepts the token as a query parameter. Every other
    # route requires the Authorization header, since a query-string token
    # lands in local access logs / shell history / browser history and there
    # is no EventSource-style constraint forcing it there for POST/GET /events.
    if allow_query_token:
        query_token = (query.get("token") or [None])[0]
        if query_token and tokens_match(query_token, token):
            return True
    return False


class TaskSwarmRequestHandler(BaseHTTPRequestHandler):
    server: TaskSwarmHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        # Silence the default access log to stderr; this is a local
        # developer tool, not a production service that needs request logs.
        pass

    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path in ("/", "/index.html"):
            self._serve_index()
            return

        if parsed.path == "/events":
            if not _is_authorized(self, self.server.token, query, allow_query_token=False):
                _send_json(self, 401, {"error": "unauthorized"})
                return
            self._handle_get_events()
            return

        if parsed.path == "/live":
            if not _is_authorized(self, self.server.token, query, allow_query_token=True):
                _send_json(self, 401, {"error": "unauthorized"})
                return
            self._handle_live()
            return

        _send_json(self, 404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib method name
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/events":
            if not _is_authorized(self, self.server.token, query, allow_query_token=False):
                _send_json(self, 401, {"error": "unauthorized"})
                return
            self._handle_post_event()
            return

        _send_json(self, 404, {"error": "not found"})

    def _serve_index(self) -> None:
        try:
            with open(os.path.join(_UI_DIR, "index.html"), "r", encoding="utf-8") as handle:
                html = handle.read()
        except OSError:
            _send_json(self, 500, {"error": "ui assets not found"})
            return
        payload = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> Optional[bytes]:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            return b""
        try:
            length = int(content_length)
        except ValueError:
            return b""
        if length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length)

    def _handle_post_event(self) -> None:
        raw = self._read_body()
        if raw is None:
            _send_json(self, 413, {"error": "request body too large"})
            return

        try:
            parsed_json = json.loads(raw) if len(raw) > 0 else {}
        except json.JSONDecodeError:
            _send_json(self, 400, {"error": "invalid JSON body"})
            return

        try:
            validated = parse_agent_event_input(parsed_json)
        except EventValidationError as error:
            _send_json(self, 400, {"error": "invalid event", "details": error.details})
            return

        event = to_agent_event(validated)
        previous_status, previous_blocked_reason = self.server.store.append(event)
        notify(event, previous_status, previous_blocked_reason, self.server.notify_options)

        _send_json(self, 201, event.to_dict())

    def _handle_get_events(self) -> None:
        sessions = self.server.store.list_sessions()
        _send_json(
            self,
            200,
            {
                "sessions": [
                    {
                        "session_id": s.session_id,
                        "latest": s.latest.to_dict(),
                        "history": [e.to_dict() for e in s.history],
                    }
                    for s in sessions
                ]
            },
        )

    def _handle_live(self) -> None:
        with self.server.sse_lock:
            at_capacity = len(self.server.sse_clients) >= _MAX_SSE_CLIENTS
        if at_capacity:
            _send_json(self, 503, {"error": "too many concurrent /live connections"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

        client_queue: "queue.Queue[str]" = queue.Queue()
        with self.server.sse_lock:
            self.server.sse_clients.add(client_queue)
        try:
            while True:
                try:
                    frame = client_queue.get(timeout=_SSE_HEARTBEAT_SECONDS)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with self.server.sse_lock:
                self.server.sse_clients.discard(client_queue)


def create_http_server(store: EventStore, token: str, notify_options: Optional[NotifyOptions] = None) -> TaskSwarmHTTPServer:
    """Creates (but does not start listening on) the TaskSwarm HTTP+SSE
    server, bound to a placeholder address. Call `server.server_bind()` and
    `server.server_activate()` (or use `server/index.py`'s `start_server`)
    to actually listen."""
    server = TaskSwarmHTTPServer(("127.0.0.1", 0), TaskSwarmRequestHandler, bind_and_activate=False)
    server.store = store
    server.token = token
    server.notify_options = notify_options or NotifyOptions()
    server.sse_clients = set()
    server.sse_lock = threading.Lock()

    def _on_event(event: Any) -> None:
        frame = f"data: {json.dumps(event.to_dict())}\n\n"
        with server.sse_lock:
            clients = list(server.sse_clients)
        for client_queue in clients:
            client_queue.put(frame)

    store.add_listener(_on_event)
    return server
