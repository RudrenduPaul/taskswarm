"""MCP server for taskswarm-cli: a generic subprocess-wrapper tool that shells out to
the installed `taskswarm` CLI and returns its parsed JSON output.

Requires the `mcp` extra (`pip install "taskswarm-cli[mcp]"`). Started via the
`taskswarm-mcp` console script (stdio transport), so any MCP-compatible agent runtime
can call `run` directly instead of shelling out to the CLI itself and parsing text.

Uses `mcp.server.MCPServer`, the official SDK's current high-level server class (`mcp`
2.0.0+). Earlier `mcp` 1.x releases exposed the same `.tool()`/`.run()` pattern under
`mcp.server.fastmcp.FastMCP` -- that module was removed in the 2.0.0 release. If a future
`mcp` major version renames this again, this is the one file that needs to change.

The `run` tool never raises: every subprocess failure mode (the CLI missing from PATH, a
launch-level OSError, a timeout, a non-zero exit, unparseable stdout) is caught and returned
as a `{"error": ...}` dict instead of propagating.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

from mcp.server import MCPServer

_CLI_NAME = "taskswarm"
_TIMEOUT_SECONDS = 30

_TOOL_DESCRIPTION = (
    "Executes the installed `taskswarm` CLI with the given argument list and returns its "
    "parsed JSON output as a dict, so an agent gets structured data instead of scraping "
    "terminal text. taskswarm is a self-hosted, event-driven coordination server for "
    "parallel coding-agent sessions (Claude Code, Codex, Cursor): a small local HTTP+SSE "
    "server that fires a native OS notification and updates a live status page the instant "
    "a tracked session transitions to blocked, needs-review, failed, or done.\n\n"
    "Call this to start the server, register or list tracked tasks, report a session's "
    "status transition, rotate the local API bearer token, or install the Claude Code "
    "hooks integration. Don't call it for anything outside these subcommands -- it only "
    "ever launches the `taskswarm` binary found on PATH with the given argv, never an "
    "arbitrary shell command. No API key is required; the CLI self-provisions a bearer "
    "token on first run at ~/.taskswarm/config.json (written 0600). `task add`, `agent "
    "report-status`, and the live status page all require a running server -- start one "
    "first with args=['start'] if `task list` or `report-status` calls report the server "
    "unreachable.\n\n"
    "Side effects vary by subcommand: `start` and `task list` are read-only queries; "
    "`task add`, `agent report-status`, and `token rotate` write to the local event log "
    "and config; `hooks install` writes Stop/Notification hook entries into "
    ".claude/settings.json. All network activity is a local HTTP call to 127.0.0.1 unless "
    "the user has opted into the ntfy.sh push channel in their own config -- this tool "
    "never reaches the network on your behalf otherwise. `token rotate` and `task add` are "
    "not idempotent (each call invalidates the prior token / creates a new task); `hooks "
    "install` and `task list` are safe to repeat. Every failure mode -- CLI missing from "
    "PATH, a launch error, a timeout, a non-zero exit, unparseable stdout -- is caught here "
    "and returned as {\"error\": \"...\"} instead of raising, so this handler can never "
    "crash the server.\n\n"
    "`args` is a list[str]: the exact CLI argv to pass to `taskswarm`, excluding the binary "
    "name itself. Always include '--json' when the subcommand supports it (all of them do) "
    "so the output is guaranteed machine-parseable. Real examples: "
    "args=['start', '--json'] boots the server and returns its status-page URL and token; "
    "args=['task', 'add', '--title', 'fix-auth-bug', '--repo', '/path/to/repo', '--json'] "
    "registers a task and returns its id; "
    "args=['agent', 'report-status', '--task', 'fix-auth-bug', '--repo', '/path/to/repo', "
    "'--state', 'blocked', '--blocked-reason', 'waiting on permission', '--json'] reports a "
    "state transition (state is one of queued, running, blocked, needs-review, done, "
    "failed). Pass ['--help'] or ['<subcommand>', '--help'] as args to discover the full, "
    "current command tree straight from the CLI rather than guessing.\n\n"
    "Returns a dict: on success, the CLI's own parsed JSON for that subcommand (e.g. "
    "`task list` returns tracked tasks with id/title/repo/status fields; `task add` "
    "returns the new task's id; `start` returns the status-page URL and bearer token). On "
    "failure, {\"error\": <message>} and often {\"returncode\": <int>}. Non-JSON stdout is "
    "returned verbatim as {\"returncode\", \"stdout\", \"stderr\"} rather than dropped."
)

mcp = MCPServer("taskswarm")


@mcp.tool(description=_TOOL_DESCRIPTION)
def run(args: list[str]) -> dict[str, Any]:
    """Shells out to the installed `taskswarm` CLI with `args` and returns its parsed
    JSON output.

    Example: run(args=["task", "list", "--json"]) returns every tracked task, enriched
    with live status when the local server is reachable.

    Every failure mode is caught here -- a missing CLI, a launch-level OSError, a timeout, a
    non-zero exit code, or unparseable stdout -- and returned as {"error": ...} instead of
    raising, so this tool handler can never crash the server.
    """
    cli_path = shutil.which(_CLI_NAME)
    if cli_path is None:
        return {"error": f"'{_CLI_NAME}' was not found on PATH. Is taskswarm-cli installed?"}

    try:
        result = subprocess.run(
            [cli_path, *args],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except OSError as exc:
        return {"error": f"failed to launch '{_CLI_NAME}': {exc}"}
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"'{_CLI_NAME} {' '.join(args)}' timed out after {_TIMEOUT_SECONDS}s"
            )
        }

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()

    if result.returncode != 0:
        return {
            "error": stderr or stdout or f"'{_CLI_NAME}' exited with code {result.returncode}",
            "returncode": result.returncode,
        }

    if not stdout:
        return {"returncode": result.returncode, "stdout": "", "stderr": stderr}

    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        return {"returncode": result.returncode, "stdout": stdout, "stderr": stderr}

    if isinstance(parsed, dict):
        return parsed
    return {"result": parsed}


def main() -> None:
    """Starts the MCP server on stdio transport. Console-script entry point for
    `taskswarm-mcp`."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
