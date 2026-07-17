"""Integration with Claude Code's real hooks system. Ported from
src/adapters/claude-code-adapter.ts.

VERIFIED against Claude Code's published hooks reference
(https://code.claude.com/docs/en/hooks.md and hooks-guide.md), same as the
TypeScript version:
  - Hooks are configured under a top-level "hooks" key in settings.json,
    scoped by file location: project (.claude/settings.json), local
    (.claude/settings.local.json, gitignored), or user (~/.claude/settings.json).
  - Each event maps to an array of { matcher, hooks: [{ type, command, timeout }] }
    groups. matcher: "" (or omitted) matches every occurrence of the event.
  - The "Stop" event fires when Claude Code finishes responding to a turn.
    Its hook receives a JSON payload on stdin with at least: session_id,
    transcript_path, cwd, hook_event_name.
  - The "Notification" event fires when Claude Code surfaces a notification
    to the user (permission prompts, idle waits, etc). Its hook receives
    session_id, cwd, hook_event_name, and notification_type.
  - Exit code 0 from a hook command is treated as "no objection"; this
    adapter's relay always exits 0 (it only reports status, it never wants
    to block Claude Code from stopping).

BEST-EFFORT / NOT independently verified against a live Claude Code install
in this codebase (same caveats as the TypeScript version):
  - The exhaustive set of notification_type values beyond "permission_prompt"
    and "idle_prompt" -- everything else falls through to a generic
    "needs-review" so nothing is silently dropped.
  - "Stop" firing semantics are per-turn, not per-task -- so mapping Stop
    directly to TaskSwarm's 'done' status is a v0.1 approximation.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .types import AdapterValidationError, AgentAdapter

HookInstallScope = str  # "project" | "local" | "user"

# A stable substring every relay command contains, used to find and replace
# a previously installed relay hook (e.g. after an upgrade moves the CLI's
# install path) without leaving stale or duplicate entries behind.
_RELAY_MARKER = "hooks claude-code-relay"


class ClaudeCodeAdapter(AgentAdapter):
    agent_type = "claude-code"
    name = "Claude Code hooks adapter"

    def to_event_input(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        session_id = raw.get("session_id")
        cwd = raw.get("cwd")
        hook_event_name = raw.get("hook_event_name")

        if not isinstance(session_id, str) or len(session_id) == 0:
            raise AdapterValidationError("session_id is required in the hook payload")
        if not isinstance(cwd, str) or len(cwd) == 0:
            raise AdapterValidationError("cwd is required in the hook payload")
        if not isinstance(hook_event_name, str):
            raise AdapterValidationError("hook_event_name is required in the hook payload")

        base = {"session_id": session_id, "repo": cwd, "agent_type": self.agent_type}

        if hook_event_name == "Stop":
            return {**base, "status": "done"}

        if hook_event_name == "Notification":
            notification_type = raw.get("notification_type")
            if notification_type == "permission_prompt":
                return {
                    **base,
                    "status": "needs-review",
                    "blocked_reason": "Claude Code is waiting for permission approval",
                }
            if notification_type == "idle_prompt":
                return {
                    **base,
                    "status": "blocked",
                    "blocked_reason": "Claude Code session is idle, waiting for the next prompt",
                }
            return {
                **base,
                "status": "needs-review",
                "blocked_reason": (
                    f"Notification: {notification_type}"
                    if isinstance(notification_type, str)
                    else "Claude Code sent a notification"
                ),
            }

        raise AdapterValidationError(
            f"unsupported hook_event_name: {hook_event_name} (this adapter handles Stop and Notification)"
        )


def build_relay_command(cli_script_path: str) -> str:
    """Builds the exact command Claude Code should run for the Stop/
    Notification hooks: the absolute path to the currently-installed
    `taskswarm`/`taskswarm-cli` console script.

    A Python console script (unlike the TS CLI's plain `.js` file) is
    directly executable on its own -- it carries its own shebang line
    pointing at the interpreter it was installed for -- so, unlike the
    Node port, this does not need to separately quote an interpreter path
    ahead of the script path.

    Deliberately NOT invoked via `python -m taskswarm.cli` or a bare
    `taskswarm` looked up fresh from PATH on every hook fire: this resolves
    once, at install time, to the exact script already on disk, and that
    resolved path is what gets written into settings.json. The rationale is
    the same supply-chain one documented in the original TypeScript
    adapter: `Stop` fires on every Claude Code turn, so a hook command that
    re-resolves against a floating reference (a PATH lookup that could
    change, or a package registry) on every single fire is a needless
    repeated trust decision. Invoking the exact binary already resolved at
    install time means the hook only ever runs code that was already
    trusted at that point.
    """
    return shlex.quote(cli_script_path) + " hooks claude-code-relay"


def _settings_path_for_scope(scope: HookInstallScope, project_dir: str, home_dir: str) -> str:
    if scope == "project":
        return str(Path(project_dir) / ".claude" / "settings.json")
    if scope == "local":
        return str(Path(project_dir) / ".claude" / "settings.local.json")
    if scope == "user":
        return str(Path(home_dir) / ".claude" / "settings.json")
    raise AdapterValidationError(f"unknown hook install scope: {scope}")


def _read_settings(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    raw = Path(path).read_text(encoding="utf-8").strip()
    if len(raw) == 0:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise AdapterValidationError(
            f"{path} is not valid JSON, so TaskSwarm can't safely merge hooks into it. "
            f"Fix or remove the file, then re-run hooks install. ({error})"
        ) from error


def _find_relay_hook_command(groups: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    if not groups:
        return None
    for group in groups:
        for hook in group.get("hooks", []):
            if _RELAY_MARKER in hook.get("command", ""):
                return hook["command"]
    return None


def _add_relay_hook(settings: Dict[str, Any], event: str, relay_command: str) -> bool:
    """Installs or repoints the relay hook for one event. Idempotent when
    the resolved command hasn't changed; self-healing (replaces the stale
    entry rather than adding a duplicate) when it has, e.g. after the CLI's
    install path moved between an upgrade."""
    settings.setdefault("hooks", {})
    existing = settings["hooks"].get(event)
    current_command = _find_relay_hook_command(existing)
    if current_command == relay_command:
        return False

    groups_without_stale_relay = []
    for group in existing or []:
        hooks = [hook for hook in group.get("hooks", []) if _RELAY_MARKER not in hook.get("command", "")]
        if hooks:
            groups_without_stale_relay.append({**group, "hooks": hooks})

    new_group = {"matcher": "", "hooks": [{"type": "command", "command": relay_command, "timeout": 10}]}
    settings["hooks"][event] = [*groups_without_stale_relay, new_group]
    return True


@dataclass
class InstallHooksResult:
    settings_path: str
    changed: bool

    def to_dict(self) -> Dict[str, Any]:
        return {"settingsPath": self.settings_path, "changed": self.changed}


def install_claude_code_hooks(
    scope: HookInstallScope,
    project_dir: str,
    home_dir: str,
    cli_script_path: Optional[str] = None,
) -> InstallHooksResult:
    """Writes (merging with any existing content) Stop and Notification hook
    entries into the appropriate Claude Code settings.json, pointing at
    TaskSwarm's relay command -- resolved to the exact console script
    already installed on this machine, never a floating PATH lookup.
    Idempotent: running it again when the hooks are already installed and
    pointing at the same resolved path is a no-op (changed=False); repoints
    (without duplicating) if the resolved path has changed since the last
    install."""
    resolved_script_path = cli_script_path or os.path.abspath(sys.argv[0])
    if not resolved_script_path:
        raise AdapterValidationError(
            "could not resolve the running CLI script path to install a hook against"
        )
    relay_command = build_relay_command(resolved_script_path)

    settings_path = _settings_path_for_scope(scope, project_dir, home_dir)
    settings = _read_settings(settings_path)

    stop_changed = _add_relay_hook(settings, "Stop", relay_command)
    notification_changed = _add_relay_hook(settings, "Notification", relay_command)
    changed = stop_changed or notification_changed

    if changed:
        directory = os.path.dirname(settings_path)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)
        Path(settings_path).write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")

    return InstallHooksResult(settings_path=settings_path, changed=changed)
