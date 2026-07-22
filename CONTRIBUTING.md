# Contributing to TaskSwarm

Thanks for looking at this. TaskSwarm ships two independently maintained,
equally first-class distributions of the same event server: an npm
package (`taskswarm-cli`, TypeScript, repo root) and a PyPI package
(`taskswarm-cli`, Python, `python/`). Both implement the same event schema,
event-server behavior, and notification logic, and are expected to behave
identically against the same request. Please read this whole file before
opening a PR -- which section applies depends on which codebase you're
touching. The bar is simple: keep it working, keep it tested, keep it
honest.

## Ground rules

- Every change lands with tests. Neither test suite is optional scaffolding.
- A change to the event schema, the notification-dedup rule, or an
  adapter's behavior should land in **both** codebases with equivalent
  test coverage, unless you're intentionally diverging them -- say so
  explicitly in the PR description if you are.
- CLI output (human and `--json`) should read identically between the two
  CLIs wherever the underlying behavior is the same.
- No `eval`/`exec`/dynamic `require`/`import` of anything derived from a
  request, in either codebase -- see `SECURITY.md` for the full threat
  model.

## Working on the TypeScript package (repo root)

```bash
npm install
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

All four need to pass clean. CI runs the same checks (`.github/workflows/ci.yml`) plus `npm audit --audit-level=high` and a smoke test of the built CLI.

## Working on the Python package (`python/`)

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

- Source lives under `python/src/taskswarm/`, laid out to mirror the
  TypeScript module structure (`schema/`, `server/`, `notifications/`,
  `adapters/`, `client/` for the HTTP client and local task registry,
  `cli.py` for the entry point) so a change in one codebase has an obvious
  counterpart to check in the other.
- The HTTP+SSE server is built on the standard library
  (`http.server.ThreadingHTTPServer`) -- no framework dependency. Keep it
  that way; a new runtime dependency here should be a deliberate,
  discussed decision, not a default.
- Build and verify a real install before opening a PR that touches
  packaging:
  ```bash
  python3 -m build python --outdir python/dist
  python3 -m venv /tmp/ts-verify && /tmp/ts-verify/bin/pip install python/dist/*.whl
  /tmp/ts-verify/bin/taskswarm --help
  ```

## Making a change

1. If you're fixing a bug, add a test that reproduces it first, then fix it.
2. If you're touching the event schema (`src/schema/events.ts` /
   `python/src/taskswarm/schema/events.py`) or the CLI's `--json` output
   shape, treat it as a breaking-change surface. Anything consuming that
   JSON in a script depends on the shape staying stable.
3. Keep `--json` output parity: every subcommand that prints human-readable output should also support `--json` with a stable, documented shape, including on error paths.
4. No `@ts-ignore` or `@ts-expect-error` (TypeScript) or bare `except:
pass` (Python) without a comment explaining why.

## Reporting a security issue

Do not open a public issue for a security vulnerability. See
[SECURITY.md](./SECURITY.md).

## Reporting a bug

Include:

- The exact command you ran
- What you expected vs. what happened
- `taskswarm --version` and your OS/Node version

## What this repo will not accept

- Anything that makes the local, self-hosted, single-user experience require an account, a cloud dependency, or a paid tier. That stays free permanently.
- A new default notification channel that leaves the local machine. ntfy.sh support is opt-in only, and any future channel follows the same rule.

## No internal build docs

This repository does not contain and should not contain internal planning, review-process, or business-strategy documents. If you're contributing tooling config for AI coding assistants, keep it scoped to genuine engineering standards (lint, types, tests), not internal process notes.

## License

By contributing, you agree your contribution is licensed under the MIT license that covers this repository.
