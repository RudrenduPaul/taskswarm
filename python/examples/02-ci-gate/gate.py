#!/usr/bin/env python3
"""
Demonstrates the CI-gate pattern documented in docs/integrations/ci.md:
report a task's outcome, poll session state, and exit non-zero if anything
failed -- the shape a real CI step would use, minus the real CI system.

Boots its own ephemeral server so this is runnable standalone. In a real
pipeline, drop the `start_server()` call and point `config` at an
already-running server's `~/.taskswarm/config.json` instead (see
`taskswarm.load_or_create_config()`).

    python3 examples/02-ci-gate/gate.py
"""
import sys
import tempfile
from pathlib import Path

from taskswarm.adapters import GenericAdapter
from taskswarm.client.api_client import get_sessions, post_event
from taskswarm.notifications import NotifyOptions
from taskswarm.server.config import TaskSwarmConfig, generate_token
from taskswarm.server.server import start_server


def run_ci_gate(config: dict) -> int:
    """Returns the process exit code a real CI step would use: 0 if no
    tracked session ended in 'failed', 1 otherwise."""
    sessions = get_sessions(config)
    failed = [s for s in sessions if s["latest"]["status"] == "failed"]
    if failed:
        for session in failed:
            reason = session["latest"].get("blocked_reason", "no reason given")
            print(f"FAILED: {session['session_id']} ({reason})", file=sys.stderr)
        return 1
    print(f"{len(sessions)} session(s) tracked, none failed.")
    return 0


def main() -> None:
    home = tempfile.mkdtemp(prefix="taskswarm-example-")
    config = TaskSwarmConfig(token=generate_token(), port=0, host="127.0.0.1")
    running = start_server(
        config=config,
        log_path=str(Path(home) / "events.jsonl"),
        notify_options=NotifyOptions(os_notifier=lambda title, message: None),
    )

    adapter = GenericAdapter()
    # Simulate an agent task that failed partway through.
    post_event(
        running.config.to_dict(),
        adapter.to_event_input(
            {
                "session_id": "flaky-test-fix",
                "repo": "./demo-repo",
                "status": "failed",
                "agent_type": "generic",
                "blocked_reason": "test suite still red after the agent's fix",
            }
        ),
    )

    exit_code = run_ci_gate(running.config.to_dict())
    running.close()
    print(f"\nCI gate would exit with code {exit_code}")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
