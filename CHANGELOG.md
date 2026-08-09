# Changelog

All notable changes to TaskSwarm are documented in this file. This
changelog covers both distributions -- the npm package (`taskswarm-cli`,
JS/TS) and the PyPI package (`taskswarm`, Python) -- since they ship the
same event schema, event-server behavior, and notification logic; entries
note which distribution they apply to.

## [Python 0.1.2] - 2026-08-08

Fixes a stale-version bug in the Python package's `--version` output.
`taskswarm/__init__.py`'s `__version__` and `cli.py`'s separate
`PACKAGE_VERSION` constant were both hand-maintained strings that had
already drifted from the real published version -- `__version__` still
said `"0.1.0"` and `PACKAGE_VERSION` still said `"0.1.1"` while the
package had already shipped 0.1.1 on PyPI, so `taskswarm --version`
was reporting a stale, wrong version to every user and agent that
checked it.

### Fixed

- `__init__.py` now reads `__version__` live from the installed
  package's own metadata via `importlib.metadata.version("taskswarm-cli")`,
  falling back to a clearly-labeled `"0.0.0-dev"` placeholder when running
  from an uninstalled source checkout, instead of a hardcoded string that
  requires a manual bump on every release and can silently go stale.
- `cli.py` no longer keeps its own separate hardcoded `PACKAGE_VERSION`
  constant; it now imports `__version__` from the package (as
  `PACKAGE_VERSION`, so the rest of the module and the `--version`
  argparse flag needed no further changes), eliminating the second copy
  that could drift independently from the first.
- Strengthened `test_version` (now
  `test_version_flag_reports_the_real_installed_package_version`) in
  `python/tests/test_cli.py` to assert the printed `--version` output
  actually contains the real installed package's `__version__`, not just
  that the flag exits -- closing the gap the old test would have missed.

## [Python 0.1.0] - 2026-07-17

Initial release of the Python port, code-complete and tested: built,
tested (117 passing tests, including a real end-to-end
server-lifecycle suite), and packaged as `taskswarm` for PyPI
(`pip install taskswarm`). The first upload attempt hit PyPI's
account-level "too many new projects created" rate limit, unrelated to
code readiness; publishing has since completed and the package is live.
Complementary to, not a replacement for, the npm package -- both are
first-class and maintained together. See `python/README.md` for
Python-specific usage.

### Added

- `taskswarm start` / `taskswarm task add` / `taskswarm task list` /
  `taskswarm agent report-status` / `taskswarm token rotate` /
  `taskswarm hooks install <adapter>` / `taskswarm hooks
claude-code-relay` CLI, with the same subcommands, flags, and `--json`
  output contract as the npm CLI. Console scripts `taskswarm` and
  `taskswarm-cli` both install, matching the two `bin` entries the npm
  package ships.
- A genuine HTTP+SSE event server (`taskswarm.server.http_server`), built
  on `http.server.ThreadingHTTPServer` from the standard library -- zero
  runtime dependencies, matching the Node version's small footprint.
  `POST /events` ingests a status transition, `GET /events` returns current
  session state, `GET /live` streams new events over Server-Sent Events to
  the bundled live status page, and `GET /` serves that page.
- The same event schema (`taskswarm.schema.events`) as the TypeScript
  version: `event_id`, `session_id`, `repo`, `agent_type`, `status`,
  `blocked_reason`, `timestamp`, `schema_version`, with equivalent field
  limits and validation. Hand-rolled validation (no `zod` equivalent
  dependency) to keep the package dependency-free.
- An append-only JSONL event log (`~/.taskswarm/events.jsonl`) with replay
  on startup, corrupt-line tolerance, and the same durability trade-offs as
  the TypeScript `EventStore`.
- The same notification-dedup logic
  (`should_notify`/`notify` in `taskswarm.notifications.dispatch`):
  fires on a transition into `blocked`/`needs-review`/`failed`/`done`,
  keyed on the `(status, blocked_reason)` pair. Local OS notification via
  `osascript` on macOS (console + terminal-bell fallback elsewhere) is
  always on; ntfy.sh is opt-in only.
- A `GenericAdapter` (the wrapper-script integration path) and a
  `ClaudeCodeAdapter` (real Claude Code `Stop`/`Notification` hooks
  integration, including `hooks install` writing to `.claude/settings.json`
  at project/local/user scope) ported with the same behavior as the
  TypeScript adapters, including the same documented v0.1 approximation
  (`Stop` maps to `done` per-turn, not per-task).
- Bearer-token auth (`hmac.compare_digest` for constant-time comparison,
  the direct equivalent of Node's `crypto.timingSafeEqual`), a config file
  written `0600` at `~/.taskswarm/config.json`, and the same first-boot
  race-safety (`os.O_CREAT | os.O_EXCL`) preventing two racing processes
  from generating two different tokens.
- A local, file-locked task registry (`taskswarm.client.tasks_registry`)
  for `task add`/`task list`, with the same stale-lock reclamation logic as
  the TypeScript version.
- Full pytest suite (117 tests) covering the event schema, config,
  event store (including replay and corrupt-line handling), auth, both
  notification channels, both adapters, the CLI, the API client, the tasks
  registry, and a real end-to-end server-lifecycle suite that boots the
  actual HTTP+SSE server on an ephemeral port and confirms a real
  notification fires on a qualifying status transition.

### Notes

- This is a genuine, independent port -- the HTTP transport is Python's
  standard-library `http.server`, not a wrapper around the Node binary or
  a shared native component.
- One naming fix specific to this port: three modules were originally
  named identically to their containing package (`notify/notify.py` inside
  a `notify/` package, and a top-level `cli.py` alongside a `cli/`
  subpackage). Both are resolved in the shipped layout (`notifications/`
  package with a `dispatch.py` submodule; `client/` subpackage for the
  HTTP client and task registry, separate from the top-level `cli.py`
  entry point) -- called out here because the failure mode (a package
  attribute silently shadowed by a same-named re-exported symbol) produces
  confusing `ImportError`s that are easy to miss in review.
