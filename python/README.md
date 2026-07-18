# taskswarm (Python)

Self-hosted event server that pushes a notification the instant a parallel
coding-agent session blocks, needs review, fails, or finishes.

[![PyPI version](https://img.shields.io/pypi/v/taskswarm-cli.svg)](https://pypi.org/project/taskswarm-cli/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RudrenduPaul/taskswarm/blob/main/LICENSE)
[![Python versions](https://img.shields.io/pypi/pyversions/taskswarm-cli.svg)](https://pypi.org/project/taskswarm-cli/)
[![CI](https://github.com/RudrenduPaul/taskswarm/actions/workflows/ci.yml/badge.svg)](https://github.com/RudrenduPaul/taskswarm/actions/workflows/ci.yml)

## Why this exists

Running three or four coding-agent sessions in parallel turns into a
tab-switching problem: nothing pushes state to you, so you find out a
session has been sitting on a permission prompt for ten minutes only by
polling terminals by eye. TaskSwarm closes that gap: every agent session
reports its state to a small local HTTP server, and the instant one
transitions to `blocked`, `needs-review`, `failed`, or `done`, TaskSwarm
fires a local OS notification and updates a live status page over
Server-Sent Events. No polling, no account, no cloud dependency by default.

This package is the **Python distribution** of TaskSwarm -- a genuine,
independent port of the server, CLI, event schema, and notification logic,
not a wrapper around the Node binary. It has zero runtime dependencies: no
HTTP framework, no schema-validation library, nothing beyond the Python
standard library.

## Install

Live on PyPI as `taskswarm-cli` (renamed from the original `taskswarm`
package, which has stopped receiving updates and points here):

```bash
pip install taskswarm-cli
```

or with [uv](https://docs.astral.sh/uv/):

```bash
uv add taskswarm-cli
```

The complementary JS/TS distribution is already live on npm as
`taskswarm-cli` (`npm install -g taskswarm-cli`, or `npx taskswarm-cli
start` with no install step) -- see the
[project README](https://github.com/RudrenduPaul/taskswarm#readme) for
that package. Both are first-class and maintained together; neither is a
replacement for the other.

## Quickstart

```bash
# Terminal 1: start the server
taskswarm start
# TaskSwarm server listening on http://127.0.0.1:4173
# Live status page: http://127.0.0.1:4173/?token=<your-token>

# Terminal 2: report a session's status as it works
taskswarm agent report-status --task my-fix --repo ./api --state running
taskswarm agent report-status --task my-fix --repo ./api --state done
```

Open the live status page URL printed by `start`. The row for `my-fix`
updates the instant each `report-status` call lands, no refresh.

Or call the library directly, in-process, without a subprocess:

```python
from taskswarm import start_server
from taskswarm.adapters import GenericAdapter
from taskswarm.client.api_client import post_event

running = start_server()
adapter = GenericAdapter()
event_input = adapter.to_event_input(
    {"session_id": "my-fix", "repo": "./api", "status": "done", "agent_type": "generic"}
)
event = post_event(running.config.to_dict(), event_input)
print(event["session_id"], "->", event["status"])
running.close()
```

## What it does

- **Event server, not a board you have to keep open.** `taskswarm start`
  boots an HTTP+SSE server (stdlib `http.server`, no framework dependency)
  that accepts `POST /events`, serves `GET /events` for current session
  state, and streams new events over `GET /live` (Server-Sent Events) to
  the bundled live status page.
- **Push notification on the four states that mean "look at this now."**
  The moment a session's status transitions to `blocked`, `needs-review`,
  `failed`, or `done`, TaskSwarm fires a native OS notification
  (`osascript` on macOS, a terminal-bell console fallback elsewhere).
  Notification dedup keys on the `(status, blocked_reason)` pair, so a
  second, different permission prompt still notifies even though the
  status (`needs-review`) didn't change.
- **A wrapper-script adapter for any agent.**
  `taskswarm agent report-status --task <id> --repo <path> --state <state>`
  is the one primitive every integration is built on -- callable from any
  script wrapping any CLI agent (Codex, Cursor, or anything else).
- **A Claude Code hooks adapter**, ported with the same behavior as the npm
  package's: `taskswarm hooks install claude-code` writes `Stop` and
  `Notification` hook entries into `.claude/settings.json`, pointed at the
  exact, already-installed console script on disk (never a floating PATH
  lookup re-resolved on every hook fire).
- **A bearer-token-gated local API, bound to loopback by default.**
  `POST /events` and the live page both require the token TaskSwarm
  generates on first run (`~/.taskswarm/config.json`, written `0600`).
  Rotate it with `taskswarm token rotate`.
- **Agent-native by design.** Every subcommand ships a `--json` flag with a
  stable schema, including error output.
- **ntfy.sh is opt-in, never default.** The only notification channel that
  leaves your machine, and it's off unless you configure it in
  `~/.taskswarm/config.json`.

## CLI reference

| Command                             | Description                                                                                                    | Key options                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `taskswarm start`                   | Start the TaskSwarm server and print the live status page URL                                                  | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm task add`                | Register a new task                                                                                            | `--title <title>` (required), `--repo <path>` (required), `--json`                                                                                                                                                                                                       |
| `taskswarm task list`               | List tracked tasks, enriched with live status when the server is reachable                                     | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm agent report-status`     | Report a status transition for a task/session to the local server                                              | `--task <id>` (required), `--repo <path>` (required), `--state <state>` (required, one of `queued\|running\|blocked\|needs-review\|done\|failed`), `--blocked-reason <text>`, `--agent-type <type>` (`claude-code\|codex\|cursor\|generic`, default `generic`), `--json` |
| `taskswarm token rotate`            | Generate a new bearer token, invalidating the old one                                                          | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm hooks install <adapter>` | Install hooks for an agent integration (currently `claude-code`)                                               | `--scope <project\|local\|user>` (default `project`), `--project-dir <path>`, `--json`                                                                                                                                                                                   |
| `taskswarm hooks claude-code-relay` | Internal: reads a hook payload from stdin and relays it. Installed automatically; not meant to be run by hand. | none                                                                                                                                                                                                                                                                     |

`taskswarm --version` prints `taskswarm 0.1.0`. The `taskswarm-cli` console
script installed by this package is an identical alias, matching both `bin`
entries the npm package ships.

## How it works

```
agent session / hook / wrapper script
        |
        v
POST /events (bearer token required)  -> event schema validation
        |
        v
EventStore (in-memory + append-only JSONL log at ~/.taskswarm/events.jsonl)
        |
        +--> notify() -- fires on a transition into blocked/needs-review/failed/done
        |         |
        |         +--> local OS notification (always on)
        |         +--> ntfy.sh (opt-in only)
        |
        +--> GET /live (Server-Sent Events) -> live status page
```

Full data model and the exact notification-dedup rule are in
[docs/concepts.md](https://github.com/RudrenduPaul/taskswarm/blob/main/docs/concepts.md).

## Security

The local API is gated by a bearer token generated on first run and stored
`0600` at `~/.taskswarm/config.json`; the server binds to `127.0.0.1` by
default. Token comparison uses `hmac.compare_digest` (constant-time,
avoiding timing side-channels), the same property the TypeScript version
gets from `crypto.timingSafeEqual`. See
[SECURITY.md](https://github.com/RudrenduPaul/taskswarm/blob/main/SECURITY.md)
for the full posture, including what this server does **not** protect
against (it is a local developer tool, not designed to be exposed on a
shared or public network). **Honest note**: this project does not currently
publish SLSA provenance, Sigstore signatures, or an SBOM, and has no
OpenSSF Scorecard badge -- none of that infrastructure exists yet for
either distribution, so it isn't claimed here.

## Contributing

See [CONTRIBUTING.md](https://github.com/RudrenduPaul/taskswarm/blob/main/CONTRIBUTING.md)
for the full guide, covering both the TypeScript and Python codebases.

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## License

MIT, see [LICENSE](https://github.com/RudrenduPaul/taskswarm/blob/main/LICENSE).

