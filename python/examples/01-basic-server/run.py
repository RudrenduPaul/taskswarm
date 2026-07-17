#!/usr/bin/env python3
"""
Boots a real TaskSwarm server on an ephemeral port, reports a session
through queued -> running -> done using the GenericAdapter, reads back live
session state, and confirms a local notification fired on the transition
into 'done' (one of the four states TaskSwarm's notification layer watches
for). Run it directly:

    python3 examples/01-basic-server/run.py
"""
import json
import tempfile
from pathlib import Path

from taskswarm.adapters import GenericAdapter
from taskswarm.client.api_client import get_sessions, post_event
from taskswarm.notifications import NotifyOptions
from taskswarm.server.config import TaskSwarmConfig, generate_token
from taskswarm.server.server import start_server


def main() -> None:
    fired = []

    def on_notify(title: str, message: str) -> None:
        fired.append((title, message))

    # An ephemeral, isolated home dir -- this example never touches your
    # real ~/.taskswarm.
    home = tempfile.mkdtemp(prefix="taskswarm-example-")
    print(f"Using TASKSWARM_HOME={home}")

    config = TaskSwarmConfig(token=generate_token(), port=0, host="127.0.0.1")
    running = start_server(
        config=config,
        log_path=str(Path(home) / "events.jsonl"),
        notify_options=NotifyOptions(os_notifier=on_notify),
    )
    print(f"Server listening at {running.url}")

    adapter = GenericAdapter()

    for status in ("queued", "running", "done"):
        event_input = adapter.to_event_input(
            {"session_id": "example-task", "repo": "./demo-repo", "status": status, "agent_type": "generic"}
        )
        event = post_event(running.config.to_dict(), event_input)
        print(f"reported: {event['session_id']} -> {event['status']}")

    sessions = get_sessions(running.config.to_dict())
    print("\ncurrent session state:")
    print(json.dumps(sessions, indent=2))

    print(f"\nnotifications fired: {len(fired)}")
    for title, message in fired:
        print(f"  [{title}] {message}")

    assert len(fired) == 1, "expected exactly one notification, for the 'done' transition"
    running.close()
    print("\nOK: server started, event reported, notification fired, server closed cleanly.")


if __name__ == "__main__":
    main()
