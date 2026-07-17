"""Real end-to-end coverage: start the actual HTTP+SSE server on an
ephemeral port, POST real events over a real socket, read the real live
status page, stream the real /live SSE endpoint, and confirm a real
notification fires on a qualifying transition. No mocked transport layer --
this is the test that proves the Python port's server genuinely works, not
just its individual units."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from taskswarm.adapters.generic_adapter import GenericAdapter
from taskswarm.client.api_client import ApiClientError, get_sessions, post_event
from taskswarm.notifications.dispatch import NotifyOptions
from taskswarm.server.config import TaskSwarmConfig, generate_token
from taskswarm.server.server import start_server


@pytest.fixture
def running_server(isolated_taskswarm_home):
    fired = []
    config = TaskSwarmConfig(token=generate_token(), port=0, host="127.0.0.1")
    running = start_server(
        config=config,
        log_path=None,
        notify_options=NotifyOptions(os_notifier=lambda title, message: fired.append((title, message))),
    )
    running.fired = fired  # type: ignore[attr-defined]
    yield running
    running.close()


def test_server_boots_and_is_reachable(running_server):
    resp = urllib.request.urlopen(f"http://{running_server.config.host}:{running_server.config.port}/", timeout=3)
    assert resp.status == 200
    assert b"TaskSwarm" in resp.read()


def test_post_event_then_get_sessions_round_trip(running_server):
    adapter = GenericAdapter()
    event_input = adapter.to_event_input(
        {"session_id": "e2e-1", "repo": "/tmp/x", "status": "running", "agent_type": "generic"}
    )
    event = post_event(running_server.config.to_dict(), event_input)
    assert event["session_id"] == "e2e-1"
    assert event["status"] == "running"

    sessions = get_sessions(running_server.config.to_dict())
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == "e2e-1"
    assert sessions[0]["latest"]["status"] == "running"


def test_events_endpoint_requires_auth(running_server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(
            f"http://{running_server.config.host}:{running_server.config.port}/events", timeout=3
        )
    assert exc.value.code == 401


def test_wrong_token_is_rejected(running_server):
    request = urllib.request.Request(
        f"http://{running_server.config.host}:{running_server.config.port}/events",
        headers={"Authorization": "Bearer wrong-token"},
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(request, timeout=3)
    assert exc.value.code == 401


def test_invalid_event_body_returns_400(running_server):
    request = urllib.request.Request(
        f"http://{running_server.config.host}:{running_server.config.port}/events",
        data=json.dumps({"session_id": "s1"}).encode("utf-8"),  # missing required fields
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {running_server.config.token}",
        },
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(request, timeout=3)
    assert exc.value.code == 400
    body = json.loads(exc.value.read())
    assert "details" in body


def test_notification_fires_on_qualifying_transition(running_server):
    """The core promise of the product: a status transition into
    blocked/needs-review/failed/done triggers a real call through the
    notify() pipeline."""
    adapter = GenericAdapter()
    post_event(
        running_server.config.to_dict(),
        adapter.to_event_input({"session_id": "e2e-2", "repo": "/tmp/x", "status": "running", "agent_type": "generic"}),
    )
    assert running_server.fired == []  # 'running' never notifies

    post_event(
        running_server.config.to_dict(),
        adapter.to_event_input(
            {
                "session_id": "e2e-2",
                "repo": "/tmp/x",
                "status": "needs-review",
                "agent_type": "generic",
                "blocked_reason": "waiting for approval",
            }
        ),
    )
    assert len(running_server.fired) == 1
    title, message = running_server.fired[0]
    assert title == "TaskSwarm: e2e-2 needs-review"
    assert "waiting for approval" in message


def test_repeat_same_status_same_reason_does_not_renotify(running_server):
    adapter = GenericAdapter()
    payload = adapter.to_event_input(
        {"session_id": "e2e-3", "repo": "/tmp/x", "status": "failed", "agent_type": "generic", "blocked_reason": "boom"}
    )
    post_event(running_server.config.to_dict(), payload)
    post_event(running_server.config.to_dict(), payload)
    assert len(running_server.fired) == 1


def test_live_sse_stream_receives_new_event(running_server):
    """Connects to /live, then posts an event on another thread, and
    confirms the SSE stream actually delivers the frame."""
    url = f"http://{running_server.config.host}:{running_server.config.port}/live?token={running_server.config.token}"
    received = []

    def consume():
        resp = urllib.request.urlopen(url, timeout=5)
        first = resp.readline()
        received.append(first)
        # Block for the next real data frame (skip blank keep-alive framing lines).
        while True:
            line = resp.readline()
            if line.startswith(b"data:"):
                received.append(line)
                break
        resp.close()

    consumer_thread = threading.Thread(target=consume, daemon=True)
    consumer_thread.start()
    time.sleep(0.3)  # let the SSE connection register before we publish

    adapter = GenericAdapter()
    post_event(
        running_server.config.to_dict(),
        adapter.to_event_input({"session_id": "e2e-live", "repo": "/tmp/x", "status": "done", "agent_type": "generic"}),
    )

    consumer_thread.join(timeout=5)
    assert not consumer_thread.is_alive(), "SSE consumer never received the event"
    assert received[0] == b": connected\n\n" or received[0] == b": connected\n"
    assert b"e2e-live" in received[-1]


def test_body_too_large_returns_413(running_server):
    request = urllib.request.Request(
        f"http://{running_server.config.host}:{running_server.config.port}/events",
        data=b"x" * (65 * 1024),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {running_server.config.token}",
        },
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(request, timeout=3)
    assert exc.value.code == 413
