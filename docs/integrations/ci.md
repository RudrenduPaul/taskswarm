# Wiring TaskSwarm into a parallel-agent workflow

TaskSwarm is meant to run alongside a set of parallel coding-agent
sessions on your own machine, not as a CI gate in the usual pass/fail
sense -- there's no scan to run against a pull request. This doc covers
the two things people actually mean by "CI integration" for this kind of
tool: wiring an agent runner (local or on a self-hosted runner) to report
into TaskSwarm, and using the task registry to poll for failures from a
script.

## Wrapper-script integration (any agent, local or self-hosted CI)

The one integration primitive every agent works through is
`taskswarm agent report-status`. Wrap any CLI agent invocation:

```bash
#!/usr/bin/env bash
set -euo pipefail

TASK_ID="fix-flaky-test"
REPO="$(pwd)"

taskswarm agent report-status --task "$TASK_ID" --repo "$REPO" --state running

if my-coding-agent-cli run --prompt "fix the flaky test in test_foo.py"; then
  taskswarm agent report-status --task "$TASK_ID" --repo "$REPO" --state done
else
  taskswarm agent report-status --task "$TASK_ID" --repo "$REPO" --state failed \
    --blocked-reason "agent run exited non-zero"
fi
```

Run several of these in parallel (background jobs, `tmux` panes, or
separate self-hosted-runner jobs) against the same TaskSwarm server, and
the live status page shows all of them, updating in real time as each
reports in.

## Polling session state from a script (Python)

```python
from taskswarm import load_or_create_config
from taskswarm.client.api_client import get_sessions

config = load_or_create_config()
sessions = get_sessions(config.to_dict())

failed = [s for s in sessions if s["latest"]["status"] == "failed"]
if failed:
    for session in failed:
        print(f"FAILED: {session['session_id']} ({session['latest'].get('blocked_reason', 'no reason given')})")
    raise SystemExit(1)

print(f"{len(sessions)} session(s) tracked, none failed.")
```

This is the pattern `examples/02-ci-gate/` in the Python package
demonstrates end to end: start (or point at) a real server, report a
`failed` event, and show the poll-and-exit-nonzero flow a CI step would
use.

## Claude Code hooks (local development, not CI)

`taskswarm hooks install claude-code` is for interactive local sessions,
not CI -- it writes hook entries that call back into a `taskswarm` server
assumed to be running on the same machine. Running it in a CI job that
doesn't also start `taskswarm start` first will have the hook relay fail
silently (by design -- a relay failure must never interrupt an agent
session) and simply not report anything.

## ntfy.sh for a remote push notification

If you're kicking off parallel sessions on a headless machine (a
self-hosted runner without a desktop to show an OS notification on),
enable the opt-in ntfy.sh channel by editing `~/.taskswarm/config.json`:

```json
{
  "ntfy": {
    "enabled": true,
    "topicUrl": "https://ntfy.sh/your-private-topic-name"
  }
}
```

This is off by default -- the "self-hosted, no cloud dependency" property
holds without it. Turning it on is an explicit choice to also push through
ntfy.sh's public relay, in addition to (not instead of) the local OS
notification.
