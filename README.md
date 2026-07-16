# TaskSwarm

You're running three Claude Code sessions across two repos. One of them hit a permission prompt four minutes ago and has been sitting there ever since, waiting on you. You didn't know, because nothing told you. You just tabbed back to check.

TaskSwarm is a self-hosted event server that fixes that. Every agent session reports its state, and the instant one goes blocked, needs review, fails, or finishes, TaskSwarm fires a local OS notification and updates a live status page. No polling terminals. No account. No cloud dependency.

[![CI](https://github.com/RudrenduPaul/taskswarm/actions/workflows/ci.yml/badge.svg)](https://github.com/RudrenduPaul/taskswarm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Install

This repo hasn't been published to npm yet. Until it is, run it from source:

```bash
git clone https://github.com/RudrenduPaul/taskswarm.git
cd taskswarm
npm install
npm run build
node dist/cli.js start
```

Once published, this will collapse to a single `npx taskswarm-cli start`.

## What it does

- **Push notifications, from a board you don't have to keep open.** The moment a session transitions to `blocked`, `needs-review`, `failed`, or `done`, TaskSwarm fires a native OS notification (`osascript` on macOS, a terminal bell fallback elsewhere). Measured dispatch latency below. None of paperclip, Vibe Kanban, or Multica (see comparison below) do this; all three are boards you have to be looking at.
- **A live status page that updates over server-sent events, not polling.** One flat table: session, repo, agent type, status, last-event timestamp. No refresh button.
- **Real Claude Code hook integration, verified against the published hooks reference.** `taskswarm hooks install claude-code` writes `Stop` and `Notification` hook entries into `.claude/settings.json`, pointed at the exact Node binary and CLI script already on disk. It deliberately avoids `npx`; see the code comment in `src/adapters/claude-code-adapter.ts` for why floating registry resolution on every hook fire is a supply-chain risk. One caveat stated plainly: Claude Code's `Stop` hook fires per-turn, not per-task, so a long multi-turn session reports `done` after every turn in v0.1, not just the final one.
- **A wrapper-script fallback for Codex, Cursor, or anything else.** `taskswarm agent report-status --task <id> --repo <path> --state <state>` is the same primitive the Claude Code adapter calls under the hood. Any script wrapping any CLI agent can call it directly.
- **A bearer-token-gated local API, bound to loopback by default.** `POST /events` and the live page both require the token TaskSwarm generates on first run (`~/.taskswarm/config.json`, written `0600`). Rotate it with `taskswarm token rotate`.
- **Agent-native by design.** Every subcommand ships a `--json` flag with a stable schema, including error output, so a script calling this CLI never has to scrape human-formatted text.
- **ntfy.sh is opt-in, never default.** The only notification channel that leaves your machine, and it's off unless you turn it on. The self-hosted claim holds end to end without it.

## Quickstart

```bash
# Terminal 1: start the server
node dist/cli.js start
# TaskSwarm server listening on http://127.0.0.1:4173
# Live status page: http://127.0.0.1:4173/?token=<your-token>

# Terminal 2: report a session's status as it works
node dist/cli.js agent report-status --task my-fix --repo ./api --state running
node dist/cli.js agent report-status --task my-fix --repo ./api --state done
```

Open the live status page URL printed by `start`. The row for `my-fix` updates the instant each `report-status` call lands, no refresh. This is the actual output from that flow, captured while writing this README:

```json
{
  "sessions": [
    {
      "session_id": "my-fix",
      "latest": { "repo": "./api", "agent_type": "generic", "status": "done", "...": "..." },
      "history": [
        { "status": "running", "timestamp": "2026-07-15T23:46:41.376Z" },
        { "status": "done", "timestamp": "2026-07-15T23:46:41.436Z" }
      ]
    }
  ]
}
```

Wire it into Claude Code directly instead of calling `report-status` by hand:

```bash
node dist/cli.js hooks install claude-code
```

This writes `Stop`/`Notification` hooks into `.claude/settings.json` for the current project. Every turn Claude Code finishes, and every permission prompt or idle wait it surfaces, now reports into TaskSwarm automatically.

Locally track tasks independent of live session state (a lightweight to-do list, not the event feed):

```bash
node dist/cli.js task add --title "Fix flaky test" --repo ./api
node dist/cli.js task list
```

## CLI reference

Captured directly from `--help` output on the built CLI (`node dist/cli.js <command> --help`):

| Command                             | Description                                                                                                    | Key options                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `taskswarm start`                   | Start the TaskSwarm server and print the live status page URL                                                  | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm task add`                | Register a new task                                                                                            | `--title <title>` (required), `--repo <path>` (required), `--json`                                                                                                                                                                                                       |
| `taskswarm task list`               | List tracked tasks, enriched with live status when the server is reachable                                     | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm agent report-status`     | Report a status transition for a task/session to the local server                                              | `--task <id>` (required), `--repo <path>` (required), `--state <state>` (required, one of `queued\|running\|blocked\|needs-review\|done\|failed`), `--blocked-reason <text>`, `--agent-type <type>` (`claude-code\|codex\|cursor\|generic`, default `generic`), `--json` |
| `taskswarm token rotate`            | Generate a new bearer token, invalidating the old one                                                          | `--json`                                                                                                                                                                                                                                                                 |
| `taskswarm hooks install <adapter>` | Install hooks for an agent integration (currently `claude-code`)                                               | `--scope <project\|local\|user>` (default `project`), `--project-dir <path>`, `--json`                                                                                                                                                                                   |
| `taskswarm hooks claude-code-relay` | Internal: reads a hook payload from stdin and relays it. Installed automatically; not meant to be run by hand. | none                                                                                                                                                                                                                                                                     |

Every subcommand also takes `-h, --help`. `taskswarm --version` prints `0.1.0`.

### A real failure, for reference

```
$ node dist/cli.js agent report-status --task foo --repo /tmp/x --state bogus
error: option '--state <state>' argument 'bogus' is invalid. Allowed choices are queued, running, blocked, needs-review, done, failed.
```

```
$ node dist/cli.js agent report-status --task foo --repo /tmp/x --state blocked
Error: could not reach TaskSwarm server at http://127.0.0.1:4173 -- is it running? (`taskswarm start`)
```

Both exit non-zero with a plain-English message and no stack trace, including under `--json`.

## How it compares

Verified live against each project's GitHub API metadata and README, 2026-07-15. TaskSwarm's own numbers are measured, not estimated. Methodology below the table.

|                                           | **TaskSwarm**                                             | [paperclip](https://github.com/paperclipai/paperclip) | [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)                                                                                | [Multica](https://github.com/multica-ai/multica)                        |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Stars                                     | pre-launch                                                | 73,818                                                | 27,389                                                                                                                               | 40,638                                                                  |
| License                                   | MIT                                                       | MIT                                                   | Apache-2.0                                                                                                                           | Source-available (modified Apache-2.0; restricts hosted commercial use) |
| Maintenance status                        | active                                                    | active (commits today)                                | **sunsetting**: company shut down, README carries a shutdown banner, last commit 2026-04-24, about 3 months stale as of this writing | active (commits today)                                                  |
| Push/desktop notification on state change | **yes**: local OS notification by default, ntfy.sh opt-in | not found in README                                   | not found in README                                                                                                                  | not found in README                                                     |
| Primary UI                                | live status table (SSE)                                   | full Kanban board + org chart                         | full Kanban board                                                                                                                    | full Kanban board                                                       |
| Self-hosted, no account                   | yes                                                       | yes                                                   | yes (self-hosting guide, Docker)                                                                                                     | yes (Docker)                                                            |
| Idle memory footprint                     | **~39 MB** (measured)                                     | not measured (out of scope)                           | not measured (out of scope)                                                                                                          | not measured (out of scope)                                             |
| Cold start (server boot to reachable)     | **~0.19 s** (measured)                                    | not measured                                          | not measured                                                                                                                         | not measured                                                            |

TaskSwarm isn't trying to out-board any of these three. paperclip and Multica are built for running a whole roster of agents like an org chart, and Vibe Kanban (while it lasted) was a full planning-and-review workspace. TaskSwarm stays narrow: the one thing none of the three ship is a push signal when a session needs you, and that's the whole product here.

**Benchmark methodology** (so you can reproduce it): measured on macOS 26.5.1, Apple Silicon (arm64), Node v24.4.0, npm 11.15.0, 2026-07-15.

- _Cold start_: process launch to a `curl` receiving HTTP 200 from the live status page URL, timed with `time.perf_counter()`, averaged across repeated runs (158 to 188 ms observed).
- _Idle memory_: `ps -o rss` on the running `node dist/cli.js start` process, a few seconds after boot with no active sessions (38.4 to 39.4 MB observed across runs).
- _Event-ingestion-to-notification-dispatch latency_: wall-clock time for a `POST /events` request to return `201`, over 20 requests with `status: blocked` (the code path that synchronously calls `notify()`, which spawns the OS notification process, before the HTTP response is sent). Median 3.1 ms, mean 5.8 ms, p95 24.1 ms, n=20.
- _Total time-to-first-board_ (a real first-time user, fresh `git clone`): `npm install` (2.05 s) plus `npm run build` (0.78 s) plus `start` to live page reachable (0.15 s), totaling **2.99 s**, on a machine with a warm local npm cache. Target was under 60 seconds; actual measured result is roughly 20x under that.

Numbers not listed for the other three tools are not estimated placeholders. They are genuinely not measured, because running their full stacks (Rust, PostgreSQL, Docker Compose) wasn't in scope for this pass. Their star counts, license terms, and maintenance status above are verified live facts, not benchmarks.

## What TaskSwarm is, and why it exists

Running one coding agent is a conversation. Running three or four in parallel turns into a tab-switching problem: nothing pushes state to you, so you end up polling terminals by eye just to find out one of them has been sitting on a permission prompt for ten minutes. TaskSwarm exists to close that gap: a push signal for the moment a session actually needs a human.

The core (event server, CLI, live status page, Claude Code hook integration) is MIT-licensed and free to self-host, for individual use, for a team, for anything. There is no hosted tier and no paid tier shipped in this version. v0.1 is the entire product right now.

## FAQ

**Does this replace my Kanban board / Linear / GitHub Projects?**
No. Those track work items a human plans. TaskSwarm tracks live agent session state and tells you the instant it changes. Different job.

**Do I need Claude Code specifically?**
No. `taskswarm hooks install claude-code` is the one verified native integration in v0.1. Codex, Cursor, or anything else works through the same primitive that adapter calls internally: `taskswarm agent report-status`, callable from any wrapper script around any CLI agent.

**Where does my data go?**
Nowhere, by default. The server binds to `127.0.0.1`, requires a bearer token for every request, and writes state to `~/.taskswarm/` (or wherever `TASKSWARM_HOME` points) on your own disk. The only optional channel that leaves your machine is ntfy.sh, and it's off unless you explicitly enable it.

**Is this going to start charging me later?**
The MIT-licensed core stays free. Everything described in this README is the whole product as it exists today, not a trial or a limited tier of something bigger.

**Why not just use tmux and watch the panes?**
That's the status quo this project is a response to. It works until you're running more than two or three sessions at once, at which point you're spending more time polling panes than writing code.

**What happens if the server isn't running when I call a command?**
Commands that need it fail fast with a specific message (`could not reach TaskSwarm server at http://127.0.0.1:4173 -- is it running? (taskswarm start)`), not a stack trace. `task add` and `task list` still work without the server; they just skip live-status enrichment.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
npm run lint
npm run typecheck
npm run test:coverage
```

All three must pass clean. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full checklist.

## License

MIT. See [LICENSE](./LICENSE). Free to self-host, modify, and redistribute, individually or as a team. No hosted or paid tier exists in this version.
