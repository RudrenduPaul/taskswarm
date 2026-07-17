# Security Policy

TaskSwarm runs a local HTTP server that accepts state updates from your own
coding-agent sessions and fires OS notifications based on them. It is
designed as a **local, single-user developer tool**, not a
multi-tenant or internet-facing service. This document states its actual
security posture plainly, including what it does not protect against.

## Threat model and posture

- **The server binds to `127.0.0.1` by default.** It is not designed to be
  exposed on a LAN or public network. If you rebind `host` in
  `~/.taskswarm/config.json` to a non-loopback address, you are opting out
  of that default and are responsible for network-level protection (a
  firewall, a VPN, etc.) -- TaskSwarm's own access control is the single
  bearer token described below, and nothing more.
- **Authentication is a single shared bearer token**, generated on first
  run and stored `0600` at `~/.taskswarm/config.json`. There is no
  per-client identity, no roles, no scoping -- anyone who has the token can
  post any valid event for any `session_id`. This is intentional for a
  local single-user tool, not an oversight: rotate the token
  (`taskswarm token rotate`) if you believe it has leaked.
- **Token comparison is constant-time** (`hmac.compare_digest` in Python,
  `crypto.timingSafeEqual` in the npm package) to avoid a timing
  side-channel revealing the token byte-by-byte.
- **The live status page's SSE endpoint (`/live`) accepts the token as a
  query parameter**, in addition to the `Authorization` header, because
  browser `EventSource` cannot set custom headers. This is a documented
  trade-off: a token passed as a query parameter can end up in local
  access logs or shell history if you construct the URL yourself. Fine for
  a loopback-only server; be aware of it if you rebind to a LAN address.
- **`POST /events` performs real input validation** against the event
  schema (field presence, type, and length limits) before anything is
  written to the in-memory store or the on-disk JSONL log. A request body
  over 64KiB is rejected (`413`) before being read into memory in full.
- **No `eval`/`exec`/dynamic import of anything derived from a request.**
  The only subprocess invocation in this codebase is the macOS OS
  notification (`osascript -e <script>`, via `subprocess.run` with an
  argument list, never a shell string) -- event fields (`session_id`,
  `repo`, `blocked_reason`, etc.) are interpolated into that AppleScript
  string with backslash/quote escaping, the same approach the npm
  package's `os-notify.ts` uses.
- **The config file, event log, and task registry are all written with
  `0600` permissions** (owner read/write only) and their containing
  directory with `0700`.

## Supported versions

| Package               | Version | Supported                            |
| --------------------- | ------- | ------------------------------------ |
| `taskswarm-cli` (npm) | 0.1.x   | Yes (unpublished as of this writing) |
| `taskswarm` (PyPI)    | 0.1.x   | Yes                                  |

Both distributions are pre-1.0 and under active development. Security
fixes land on the latest `0.1.x` release of each; there is no older
supported line to backport to yet.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately via
[GitHub Security Advisories](https://github.com/RudrenduPaul/taskswarm/security/advisories/new)
for this repository. Include:

- Which distribution is affected (npm package, PyPI package, or both).
- A minimal reproduction: the request(s) sent to the server, or the
  command/library call that triggers the issue.
- What you expected TaskSwarm to do, and what it actually did.
- Your assessment of impact -- e.g. "an unauthenticated request can read or
  mutate session state" would be a critical trust-boundary bypass of the
  one access-control mechanism this project has (the bearer token).

## What counts as in scope

- Any way to bypass the bearer-token check on `POST /events`, `GET
/events`, or `GET /live`.
- Any code path where content from a request (event fields, hook payload
  JSON, `.claude/settings.json` content read back during `hooks install`)
  is executed, evaluated, or dynamically imported, rather than only read,
  validated, and stored.
- A crafted request that causes unbounded resource consumption (memory,
  disk, or a hang) beyond the documented 64KiB body cap.
- Any way to make TaskSwarm write outside `~/.taskswarm/` (or
  `TASKSWARM_HOME` if set) or outside the `.claude/settings.json` path
  `hooks install` is explicitly scoped to.

## What is out of scope

- The fact that the bearer token is a single shared secret with no
  per-client scoping -- that is the documented design for a local
  single-user tool, not a vulnerability. If you need multi-tenant access
  control, this tool is not built for that use case yet.
- Running the server bound to a non-loopback address without your own
  network-level protection -- that is an explicit opt-out of the default
  posture, not a TaskSwarm bug.

## Response

We aim to acknowledge a report within 5 business days and to have a fix or
a mitigation plan within 30 days for a confirmed, in-scope vulnerability.
Credit is given in the release notes unless you ask to remain anonymous.
