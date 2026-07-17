# Python examples

Each numbered subdirectory is a real, runnable script against the actual
`taskswarm` Python library, not pseudocode. Every example boots a real
`taskswarm` server (on an ephemeral port, in a temporary
`TASKSWARM_HOME`) so nothing external -- no already-running server, no
network access -- is required.

Install the package first (editable install from this checkout, or `pip
install taskswarm` from PyPI both work identically):

```bash
cd python
pip install -e .
```

Then run any example directly:

```bash
python3 examples/01-basic-server/run.py
python3 examples/02-ci-gate/gate.py
python3 examples/03-claude-code-hook/relay.py
```

| Example                                       | What it demonstrates                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01-basic-server](./01-basic-server/)         | The core library call: `start_server()`, posting an event through `GenericAdapter` + `post_event()`, reading back live session state with `get_sessions()`, and confirming a notification fired on a qualifying transition. |
| [02-ci-gate](./02-ci-gate/)                   | Using the event server as a CI-style gate: report a `failed` event, poll session state, and exit non-zero -- the pattern documented in `docs/integrations/ci.md`.                                                           |
| [03-claude-code-hook](./03-claude-code-hook/) | The agent-native use case: feeding a real Claude Code hook payload shape through `ClaudeCodeAdapter` in-process (no subprocess, no CLI), and inspecting the notification-dedup decision (`should_notify`) directly.         |
