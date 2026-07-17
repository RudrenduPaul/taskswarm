# Concepts

## The event pipeline

Both the npm and PyPI packages implement the same pipeline (TypeScript:
`src/server/http-server.ts`; Python: `taskswarm/server/http_server.py`):

```
agent session / Claude Code hook / wrapper script
        |
        v
adapter.toEventInput() / adapter.to_event_input()  -- normalizes raw,
        |                                             integration-specific
        |                                             input into a schema-
        |                                             valid event input
        v
POST /events (bearer token required)
        |
        v
event schema validation  -- field presence, type, length limits
        |
        v
EventStore.append()  -- in-memory state + append-only JSONL log on disk
        |
        +--> notify()  -- fires only on a transition into
        |         blocked/needs-review/failed/done
        |         |
        |         +--> local OS notification (always on)
        |         +--> ntfy.sh (opt-in only)
        |
        +--> GET /live (Server-Sent Events)  -->  live status page
```

Every event returned to a caller (the CLI, the library, or the live status
page) is a plain, structured object -- never a thrown exception on the
happy path. Validation failures come back as a `400` with field-level
`details`, matching zod's `.flatten()` shape on the TypeScript side and a
hand-rolled equivalent on the Python side (the Python package has zero
runtime dependencies, so there's no schema-validation library to lean on).

## The event schema

| Field | Type | Notes |
| --- | --- | --- |
| `event_id` | UUID | Stamped by the server if omitted from the input. |
| `session_id` | string, 1-256 chars | The task/session identifier you choose. |
| `repo` | string, 1-1024 chars | Path to the repository the session operates on. |
| `agent_type` | `claude-code` \| `codex` \| `cursor` \| `generic` | Which adapter produced the event. |
| `status` | `queued` \| `running` \| `blocked` \| `needs-review` \| `done` \| `failed` | Current lifecycle state. |
| `blocked_reason` | string, up to 4096 chars, optional | Human-readable reason, shown for `blocked`/`needs-review`/`failed`. |
| `timestamp` | ISO-8601 datetime with UTC offset | Stamped by the server if omitted from the input. |
| `schema_version` | positive integer | Currently `1`. Bumped only for a non-additive shape change. |

## Notification-dedup rule

`NOTIFY_ON_STATUSES` is `{blocked, needs-review, failed, done}` -- the four
states that mean "a human should look at this now." A transition into one
of these fires a notification; `queued` and `running` never do.

Dedup keys on the **`(status, blocked_reason)` pair**, not status alone:

- Two consecutive `blocked` events with the *same* `blocked_reason` are
  treated as a repeat -- no second notification.
- Two consecutive `needs-review` events with *different* `blocked_reason`
  values (e.g. two different permission prompts in a row) both notify,
  even though the status itself didn't change -- each one is a genuinely
  new thing a human should see.

This is implemented once, identically, in both distributions
(`shouldNotify()` in TypeScript, `should_notify()` in Python) and is the
single source of truth both `notify()` implementations call before firing
any channel.

## The server

- **Transport**: an HTTP server with one long-lived Server-Sent-Events
  endpoint (`GET /live`). The TypeScript version uses Node's built-in
  `http` module; the Python version uses the standard library's
  `http.server.ThreadingHTTPServer`. Neither pulls in a web framework.
- **Storage**: in-memory, keyed by `session_id`, backed by an append-only
  JSONL log (`~/.taskswarm/events.jsonl` by default, overridable via the
  `TASKSWARM_HOME` environment variable) for durability across restarts.
  No embedded database -- a deliberate choice to keep the tool
  lightweight and dependency-free. On startup, the log is replayed to
  rebuild in-memory state; corrupt or partial lines (e.g. from a crash
  mid-write) are skipped and logged, never a hard startup failure.
- **Auth**: a single bearer token, generated on first run and stored
  `0600` at `~/.taskswarm/config.json`. Comparison is constant-time
  (`crypto.timingSafeEqual` / `hmac.compare_digest`) to avoid a timing
  side-channel. `GET /live` additionally accepts the token as a query
  parameter, since browser `EventSource` cannot set custom headers.

## Adapters

An adapter's only job is normalizing agent-specific raw input into a
schema-valid event input. Two ship in v0.1:

- **`GenericAdapter`** -- the wrapper-script fallback any agent can use.
  This is what `taskswarm agent report-status` calls internally, and the
  one integration path that works for any CLI agent (Codex, Cursor,
  anything else) via a wrapper script calling that command at the points
  it cares about.
- **`ClaudeCodeAdapter`** -- a real integration with Claude Code's
  published hooks system. `Stop` (fires when Claude Code finishes
  responding to a turn) maps to `done`. `Notification` maps to
  `needs-review` (a `permission_prompt`) or `blocked` (an `idle_prompt`);
  any other notification type falls through to a generic `needs-review`
  rather than being silently dropped. **Documented v0.1 approximation**:
  `Stop` fires per-turn, not per-task, so a long multi-turn session
  reports `done` after every turn, not just the final one.

`taskswarm hooks install claude-code` writes the `Stop`/`Notification`
hook entries into `.claude/settings.json` (project, local, or user scope),
pointed at the exact, already-resolved CLI script path on disk -- never a
floating `npx`/PATH lookup re-resolved on every hook fire, which would be
a standing supply-chain risk given `Stop` fires on every single turn.

## Task registry vs. event state

`taskswarm task add`/`task list` is a separate, local, server-independent
list of human-friendly task titles (`~/.taskswarm/tasks.json`). The wire
event schema deliberately has no `title` field, so this lets you name
tasks without changing what flows over the network. `task list` enriches
each row with live status when the server happens to be reachable, but
works fine (just without that enrichment) when it isn't.
