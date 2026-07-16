# Contributing to TaskSwarm

Thanks for looking at this. TaskSwarm is a small, solo-maintained project, so the bar is simple: keep it working, keep it tested, keep it honest.

## Before opening a PR

```bash
npm install
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

All four need to pass clean. CI runs the same checks (`.github/workflows/ci.yml`) plus `npm audit --audit-level=high` and a smoke test of the built CLI.

## Making a change

1. If you're fixing a bug, add a test that reproduces it first, then fix it.
2. If you're touching the event schema (`src/schema/events.ts`) or the CLI's `--json` output shape, treat it as a breaking-change surface. Anything consuming that JSON in a script depends on the shape staying stable.
3. Keep `--json` output parity: every subcommand that prints human-readable output should also support `--json` with a stable, documented shape, including on error paths.
4. No `@ts-ignore` or `@ts-expect-error` without a comment explaining why.

## Reporting a bug

Include:

- The exact command you ran
- What you expected vs. what happened
- `taskswarm --version` and your OS/Node version

## What this repo will not accept

- Anything that makes the local, self-hosted, single-user experience require an account, a cloud dependency, or a paid tier. That stays free permanently.
- A new default notification channel that leaves the local machine. ntfy.sh support is opt-in only, and any future channel follows the same rule.

## No internal build docs

This repository does not contain and should not contain internal planning, review-process, or business-strategy documents (a root `CLAUDE.md`, `TODOS.md`, `BRANCH_PROTECTION.md`, or similar). If you're contributing tooling config for AI coding assistants, keep it scoped to genuine engineering standards (lint, types, tests), not internal process notes.

## License

By contributing, you agree your contribution is licensed under the MIT license that covers this repository.
