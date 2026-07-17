#!/usr/bin/env python3
"""
Argument-parsing entry point. Ported from src/cli.ts (which uses
`commander`); this port uses the stdlib `argparse` to avoid a CLI-framework
dependency. Subcommands, flags, and `--json` output shapes are kept
equivalent to the npm CLI's `--help` output and behavior. Console entry
points: `taskswarm` / `taskswarm-cli`, both installed via
python/pyproject.toml's `[project.scripts]`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .adapters.claude_code_adapter import install_claude_code_hooks
from .adapters.generic_adapter import GenericAdapter
from .adapters.types import AdapterValidationError
from .client.api_client import ApiClientError, get_sessions, post_event
from .client.tasks_registry import TaskRecord, add_task, list_tasks
from .schema.events import AGENT_STATUSES, AGENT_TYPES
from .server.config import load_or_create_config, rotate_token
from .server.server import start_server

PACKAGE_VERSION = "0.1.0"


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2))


def _fail(message: str, as_json: bool = False) -> None:
    """Reports a command failure and sets a non-zero exit code. Honors the
    CLI's `--json` contract: when the invocation requested `--json`, the
    error is printed as parseable `{"error": "<message>"}` on stdout (never
    stderr, so a caller piping/parsing stdout still gets valid JSON) instead
    of the plain-text `Error: ...` message."""
    if as_json:
        _print_json({"error": message})
    else:
        print(f"Error: {message}", file=sys.stderr)


def _cmd_start(args: argparse.Namespace) -> int:
    try:
        running = start_server()
    except OSError as error:
        _fail(f"failed to start server: {error}", args.json)
        return 1

    if args.json:
        _print_json({"url": running.url, "host": running.config.host, "port": running.config.port})
    else:
        print(f"TaskSwarm server listening on http://{running.config.host}:{running.config.port}")
        print(f"Live status page: {running.url}")
        print("Press Ctrl+C to stop.")

    try:
        while True:
            import time

            time.sleep(3600)
    except KeyboardInterrupt:
        running.close()
        return 0


def _cmd_task_add(args: argparse.Namespace) -> int:
    record = TaskRecord(
        id=str(uuid.uuid4()),
        title=args.title,
        repo=args.repo,
        created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    try:
        add_task(record)
    except OSError as error:
        _fail(f"failed to save task: {error}", args.json)
        return 1

    if args.json:
        _print_json(record.to_dict())
    else:
        print(f"Task created: {record.id}")
        print(f"  title: {record.title}")
        print(f"  repo:  {record.repo}")
    return 0


def _cmd_task_list(args: argparse.Namespace) -> int:
    tasks = list_tasks()
    status_by_id: Dict[str, str] = {}
    try:
        config = load_or_create_config()
        sessions = get_sessions(config.to_dict())
        for session in sessions:
            status_by_id[session["session_id"]] = session["latest"]["status"]
    except ApiClientError:
        # Server not running (or unreachable) -- task list still works, just
        # without live status enrichment.
        pass

    rows = [{**task, "status": status_by_id.get(task["id"], "unknown")} for task in tasks]

    if args.json:
        _print_json(rows)
        return 0
    if len(rows) == 0:
        print("No tasks yet. Create one with `taskswarm task add --title <t> --repo <path>`.")
        return 0
    for row in rows:
        print(f"{row['id']}  [{row['status']}]  {row['title']}  ({row['repo']})")
    return 0


def _cmd_agent_report_status(args: argparse.Namespace) -> int:
    adapter = GenericAdapter()
    raw_input: Dict[str, Any] = {
        "session_id": args.task,
        "repo": args.repo,
        "status": args.state,
        "agent_type": args.agent_type,
    }
    if args.blocked_reason:
        raw_input["blocked_reason"] = args.blocked_reason

    try:
        input_data = adapter.to_event_input(raw_input)
        config = load_or_create_config()
        event = post_event(config.to_dict(), input_data)
    except (AdapterValidationError, ApiClientError) as error:
        _fail(str(error), args.json)
        return 1

    if args.json:
        _print_json(event)
    else:
        print(f"Reported {event['session_id']} -> {event['status']}")
    return 0


def _cmd_token_rotate(args: argparse.Namespace) -> int:
    try:
        new_token = rotate_token()
    except OSError as error:
        _fail(f"failed to rotate token: {error}", args.json)
        return 1

    if args.json:
        _print_json({"token": new_token})
    else:
        print("Bearer token rotated. Update any configured clients/hooks with the new value:")
        print(new_token)
    return 0


def _cmd_hooks_install(args: argparse.Namespace) -> int:
    if args.adapter != "claude-code":
        _fail(f'unknown adapter "{args.adapter}". Supported adapters: claude-code', args.json)
        return 1
    try:
        result = install_claude_code_hooks(
            scope=args.scope,
            project_dir=args.project_dir,
            home_dir=os.path.expanduser("~"),
        )
    except (AdapterValidationError, OSError) as error:
        _fail(f"failed to install hooks: {error}", args.json)
        return 1

    if args.json:
        _print_json(result.to_dict())
    elif result.changed:
        print(f"Installed Claude Code Stop/Notification hooks -> {result.settings_path}")
    else:
        print(f"Claude Code hooks already installed at {result.settings_path}")
    return 0


def _cmd_hooks_claude_code_relay(args: argparse.Namespace) -> int:
    """Reads a Claude Code hook payload from stdin and relays it to the
    local TaskSwarm server. Installed automatically by `taskswarm hooks
    install claude-code`; not meant to be run by hand. This command must
    never fail the hook (which could interrupt the coding session), so
    every error path logs to stderr and still exits 0."""
    from .adapters.claude_code_adapter import ClaudeCodeAdapter

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        adapter = ClaudeCodeAdapter()
        input_data = adapter.to_event_input(payload)
        config = load_or_create_config()
        post_event(config.to_dict(), input_data)
    except Exception as error:  # noqa: BLE001 -- must never propagate a nonzero exit into the hook
        sys.stderr.write(f"taskswarm hook relay: {error}\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="taskswarm",
        description=(
            "Self-hosted, event-driven coordination for parallel coding-agent sessions "
            "(Claude Code, Codex, Cursor)."
        ),
    )
    parser.add_argument("--version", action="version", version=f"taskswarm {PACKAGE_VERSION}")
    subparsers = parser.add_subparsers(dest="command")

    start_parser = subparsers.add_parser(
        "start", help="Start the TaskSwarm server and print the live status page URL"
    )
    start_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    start_parser.set_defaults(func=_cmd_start)

    task_parser = subparsers.add_parser("task", help="Manage locally tracked tasks")
    task_subparsers = task_parser.add_subparsers(dest="task_command")

    task_add_parser = task_subparsers.add_parser("add", help="Register a new task")
    task_add_parser.add_argument("--title", required=True, help="human-readable task title")
    task_add_parser.add_argument("--repo", required=True, help="path to the repository the task operates on")
    task_add_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    task_add_parser.set_defaults(func=_cmd_task_add)

    task_list_parser = task_subparsers.add_parser(
        "list", help="List tracked tasks, enriched with live status when the server is reachable"
    )
    task_list_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    task_list_parser.set_defaults(func=_cmd_task_list)

    agent_parser = subparsers.add_parser("agent", help="Report agent session status")
    agent_subparsers = agent_parser.add_subparsers(dest="agent_command")

    report_status_parser = agent_subparsers.add_parser(
        "report-status",
        help="Report a status transition for a task/session to the local TaskSwarm server",
    )
    report_status_parser.add_argument("--task", required=True, help="task/session id (the id returned by `task add`)")
    report_status_parser.add_argument("--repo", required=True, help="path to the repository the session operates on")
    report_status_parser.add_argument("--state", required=True, choices=AGENT_STATUSES, help="new status")
    report_status_parser.add_argument(
        "--blocked-reason", dest="blocked_reason", default=None,
        help="reason, shown when status is blocked/needs-review/failed",
    )
    report_status_parser.add_argument(
        "--agent-type", dest="agent_type", choices=AGENT_TYPES, default="generic", help="reporting agent"
    )
    report_status_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    report_status_parser.set_defaults(func=_cmd_agent_report_status)

    token_parser = subparsers.add_parser("token", help="Manage the API bearer token")
    token_subparsers = token_parser.add_subparsers(dest="token_command")

    token_rotate_parser = token_subparsers.add_parser(
        "rotate", help="Generate a new bearer token, invalidating the old one"
    )
    token_rotate_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    token_rotate_parser.set_defaults(func=_cmd_token_rotate)

    hooks_parser = subparsers.add_parser("hooks", help="Manage agent hook integrations")
    hooks_subparsers = hooks_parser.add_subparsers(dest="hooks_command")

    hooks_install_parser = hooks_subparsers.add_parser(
        "install", help="Install TaskSwarm hooks for an agent integration (currently: claude-code)"
    )
    hooks_install_parser.add_argument("adapter", help="adapter name, e.g. claude-code")
    hooks_install_parser.add_argument(
        "--scope", choices=["project", "local", "user"], default="project",
        help="settings.json scope to write hooks into",
    )
    hooks_install_parser.add_argument(
        "--project-dir", dest="project_dir", default=os.getcwd(),
        help="project directory (for project/local scope)",
    )
    hooks_install_parser.add_argument("--json", action="store_true", help="output machine-readable JSON")
    hooks_install_parser.set_defaults(func=_cmd_hooks_install)

    hooks_relay_parser = hooks_subparsers.add_parser(
        "claude-code-relay",
        help=(
            "Internal: reads a Claude Code hook payload from stdin and relays it to the "
            "local TaskSwarm server. Installed automatically by `taskswarm hooks install "
            "claude-code`; not meant to be run by hand."
        ),
    )
    hooks_relay_parser.set_defaults(func=_cmd_hooks_claude_code_relay)

    return parser


def run_cli(argv: List[str]) -> int:
    """`argv` follows the sys.argv convention: argv[0] is the program name,
    the real arguments start at argv[1]. Returns the process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv[1:])

    if not hasattr(args, "func"):
        parser.print_help()
        return 0
    return args.func(args)


def main() -> None:
    try:
        code = run_cli(sys.argv)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:  # noqa: BLE001 -- top-level crash guard, mirrors src/cli.ts's catch-all
        print(str(error), file=sys.stderr)
        sys.exit(1)
    else:
        sys.exit(code)


if __name__ == "__main__":
    main()
