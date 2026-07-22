# Getting started

TaskSwarm is a self-hosted event server: agent sessions (or a wrapper
script around any CLI agent) report their status to a small local HTTP
server, and the instant a session transitions to `blocked`,
`needs-review`, `failed`, or `done`, TaskSwarm fires a local OS
notification and updates a live status page over Server-Sent Events. It
ships as two independent, equally first-class packages that speak the same
wire protocol: an npm package (`taskswarm-cli`, JavaScript/TypeScript) and
a PyPI package (`taskswarm-cli`, Python). Pick whichever fits your toolchain,
or run both against the same server -- the server and CLI don't need to be
the same distribution.

## Install

**npm (JS/TS server + CLI):**

```bash
npm install -g taskswarm-cli
taskswarm start
```

**pip (Python server + CLI):**

```bash
pip install taskswarm-cli
taskswarm start
```

Neither install pulls anything at server-start time. No embedded database,
no external binary, no network fetch.

## Your first session

Start the server in one terminal:

```bash
# npm
taskswarm start

# Python
taskswarm start
```

```
TaskSwarm server listening on http://127.0.0.1:4173
Live status page: http://127.0.0.1:4173/?token=<your-token>
Press Ctrl+C to stop.
```

Open the printed live status page URL in a browser -- it's empty for now.

In a second terminal, report a session's status as it works:

```bash
taskswarm agent report-status --task my-fix --repo ./api --state running
taskswarm agent report-status --task my-fix --repo ./api --state done
```

The row for `my-fix` appears and updates on the live status page the
instant each `report-status` call lands, no refresh needed (it's pushed
over the page's open SSE connection to `GET /live`). The second call also
fires a local OS notification, because `done` is one of the four states
TaskSwarm's notification layer watches for (`blocked`, `needs-review`,
`failed`, `done`).

## Wiring a real agent in: Claude Code hooks

```bash
taskswarm hooks install claude-code
```

This writes `Stop` and `Notification` hook entries into the current
project's `.claude/settings.json`, pointed at the exact, already-installed
CLI script on disk. From then on, every turn Claude Code finishes and
every permission prompt or idle wait it surfaces reports into TaskSwarm
automatically -- no manual `report-status` calls needed for that project.

## Using the library instead of the CLI

Both packages export a programmatic API for embedding TaskSwarm's server
or client in your own tooling instead of shelling out to the CLI.

**Python:**

```python
from taskswarm import start_server
from taskswarm.adapters import GenericAdapter
from taskswarm.client.api_client import post_event

running = start_server()
adapter = GenericAdapter()
event = post_event(
    running.config.to_dict(),
    adapter.to_event_input({"session_id": "my-fix", "repo": "./api", "status": "done", "agent_type": "generic"}),
)
print(event["session_id"], "->", event["status"])
running.close()
```

**TypeScript:**

```ts
import { startServer } from 'taskswarm-cli';

const running = await startServer();
console.log(running.url);
await running.close();
```

## Next steps

- [concepts.md](./concepts.md) -- the event schema, the notification-dedup
  rule, and how the server, adapters, and CLI fit together.
- [integrations/ci.md](./integrations/ci.md) -- wiring TaskSwarm into a
  parallel-agent workflow.
- The [project README](../README.md) for the full comparison table and
  benchmark numbers (TypeScript distribution).
