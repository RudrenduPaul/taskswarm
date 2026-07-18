"""Boots the event store + HTTP/SSE server and starts listening. Ported
from src/server/index.ts."""
from __future__ import annotations

import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import quote

from ..notifications.dispatch import NotifyOptions
from .config import TaskSwarmConfig, get_event_log_path, load_or_create_config
from .event_store import EventStore
from .http_server import TaskSwarmHTTPServer, create_http_server

# Sentinel distinguishing "no log_path argument given" (use the default
# path) from "log_path=None passed explicitly" (disable persistence).
_UNSET = object()


@dataclass
class RunningServer:
    server: TaskSwarmHTTPServer
    store: EventStore
    config: TaskSwarmConfig
    url: str
    close: Callable[[], None]


def start_server(
    config: Optional[TaskSwarmConfig] = None,
    log_path: Any = _UNSET,
    notify_options: Optional[NotifyOptions] = None,
) -> RunningServer:
    resolved_config = config or load_or_create_config()
    resolved_log_path = None if log_path is None else (get_event_log_path() if log_path is _UNSET else log_path)

    resolved_notify_options = notify_options
    if resolved_notify_options is None:
        ntfy = resolved_config.ntfy or {}
        resolved_notify_options = NotifyOptions(ntfy=ntfy if ntfy.get("enabled") else None)

    store = EventStore(resolved_log_path)
    server = create_http_server(store, resolved_config.token, resolved_notify_options)
    server.server_address = (resolved_config.host, resolved_config.port)
    server.server_bind()
    server.server_activate()
    # The actual bound port (relevant when port=0 was requested, e.g. in tests).
    resolved_config.port = server.server_address[1]

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    if resolved_config.host not in ("127.0.0.1", "localhost", "::1"):
        # Two things get worse off loopback: the bearer token travels in
        # plaintext http:// (no TLS path exists), and it's accepted as a
        # ?token= query parameter for /live, which lands in local access logs.
        print(
            f'[taskswarm] warning: binding to "{resolved_config.host}" instead of loopback -- '
            "the API token is sent over plaintext http:// with no TLS, and is accepted as a URL "
            "query parameter for /live (visible in local access logs). Only do this on a "
            "network you trust.",
            file=sys.stderr,
        )

    url = f"http://{resolved_config.host}:{resolved_config.port}/?token={quote(resolved_config.token)}"

    def close() -> None:
        server.shutdown()
        server.server_close()

    return RunningServer(server=server, store=store, config=resolved_config, url=url, close=close)
