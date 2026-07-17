#!/usr/bin/env python3
"""
The agent-native use case: feeds a real Claude Code hook payload shape
(the same JSON shape Claude Code writes to a hook's stdin) through
ClaudeCodeAdapter in-process -- no CLI subprocess, no server needed for
this part -- and inspects the resulting event input plus the
notification-dedup decision (should_notify) directly.

    python3 examples/03-claude-code-hook/relay.py
"""
import json

from taskswarm.adapters import ClaudeCodeAdapter
from taskswarm.notifications import should_notify

# A realistic 'Notification' hook payload -- the shape Claude Code writes
# to stdin when a permission prompt appears mid-session.
permission_prompt_payload = {
    "session_id": "claude-session-42",
    "cwd": "/Users/demo/projects/api",
    "hook_event_name": "Notification",
    "notification_type": "permission_prompt",
}

# A 'Stop' payload -- fires when Claude Code finishes responding to a turn.
stop_payload = {
    "session_id": "claude-session-42",
    "cwd": "/Users/demo/projects/api",
    "hook_event_name": "Stop",
}


def main() -> None:
    adapter = ClaudeCodeAdapter()

    print("Permission-prompt hook -> event input:")
    permission_event = adapter.to_event_input(permission_prompt_payload)
    print(json.dumps(permission_event, indent=2))

    print("\nStop hook -> event input:")
    stop_event = adapter.to_event_input(stop_payload)
    print(json.dumps(stop_event, indent=2))

    # Notification-dedup: a first 'needs-review' with no prior status
    # notifies. A second, identical-reason 'needs-review' right after does
    # not (it's a repeat). A third 'needs-review' with a *different*
    # blocked_reason (a different permission prompt) notifies again, even
    # though the status itself hasn't changed.
    print("\nNotification-dedup walkthrough:")
    decisions = [
        ("first permission prompt", should_notify("needs-review", None, permission_event["blocked_reason"], None)),
        (
            "identical repeat",
            should_notify(
                "needs-review", "needs-review", permission_event["blocked_reason"], permission_event["blocked_reason"]
            ),
        ),
        (
            "a second, different prompt",
            should_notify("needs-review", "needs-review", "a different reason entirely", permission_event["blocked_reason"]),
        ),
    ]
    for label, decision in decisions:
        print(f"  {label}: should_notify = {decision}")

    assert decisions[0][1] is True
    assert decisions[1][1] is False
    assert decisions[2][1] is True
    print("\nOK: dedup decisions matched the documented rule (docs/concepts.md).")


if __name__ == "__main__":
    main()
