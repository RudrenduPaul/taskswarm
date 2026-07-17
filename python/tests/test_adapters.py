import json
import os

import pytest

from taskswarm.adapters.claude_code_adapter import (
    ClaudeCodeAdapter,
    build_relay_command,
    install_claude_code_hooks,
)
from taskswarm.adapters.generic_adapter import GenericAdapter
from taskswarm.adapters.types import AdapterValidationError


class TestGenericAdapter:
    def test_valid_input(self):
        adapter = GenericAdapter()
        result = adapter.to_event_input(
            {"session_id": "s1", "repo": "/tmp/x", "status": "running", "agent_type": "generic"}
        )
        assert result == {"session_id": "s1", "repo": "/tmp/x", "agent_type": "generic", "status": "running"}

    def test_defaults_agent_type_to_generic(self):
        adapter = GenericAdapter()
        result = adapter.to_event_input({"session_id": "s1", "repo": "/tmp/x", "status": "running"})
        assert result["agent_type"] == "generic"

    def test_includes_blocked_reason_when_present(self):
        adapter = GenericAdapter()
        result = adapter.to_event_input(
            {"session_id": "s1", "repo": "/tmp/x", "status": "blocked", "blocked_reason": "waiting"}
        )
        assert result["blocked_reason"] == "waiting"

    def test_rejects_missing_session_id(self):
        adapter = GenericAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"repo": "/tmp/x", "status": "running"})

    def test_rejects_missing_repo(self):
        adapter = GenericAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"session_id": "s1", "status": "running"})

    def test_rejects_bad_status(self):
        adapter = GenericAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"session_id": "s1", "repo": "/tmp/x", "status": "bogus"})

    def test_rejects_bad_agent_type(self):
        adapter = GenericAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input(
                {"session_id": "s1", "repo": "/tmp/x", "status": "running", "agent_type": "bogus"}
            )


class TestClaudeCodeAdapter:
    def test_stop_event_maps_to_done(self):
        adapter = ClaudeCodeAdapter()
        result = adapter.to_event_input(
            {"session_id": "s1", "cwd": "/tmp/x", "hook_event_name": "Stop"}
        )
        assert result == {"session_id": "s1", "repo": "/tmp/x", "agent_type": "claude-code", "status": "done"}

    def test_permission_prompt_maps_to_needs_review(self):
        adapter = ClaudeCodeAdapter()
        result = adapter.to_event_input(
            {
                "session_id": "s1",
                "cwd": "/tmp/x",
                "hook_event_name": "Notification",
                "notification_type": "permission_prompt",
            }
        )
        assert result["status"] == "needs-review"
        assert "permission approval" in result["blocked_reason"]

    def test_idle_prompt_maps_to_blocked(self):
        adapter = ClaudeCodeAdapter()
        result = adapter.to_event_input(
            {
                "session_id": "s1",
                "cwd": "/tmp/x",
                "hook_event_name": "Notification",
                "notification_type": "idle_prompt",
            }
        )
        assert result["status"] == "blocked"

    def test_unknown_notification_type_falls_through_to_needs_review(self):
        adapter = ClaudeCodeAdapter()
        result = adapter.to_event_input(
            {
                "session_id": "s1",
                "cwd": "/tmp/x",
                "hook_event_name": "Notification",
                "notification_type": "something_new",
            }
        )
        assert result["status"] == "needs-review"
        assert "something_new" in result["blocked_reason"]

    def test_rejects_unsupported_hook_event(self):
        adapter = ClaudeCodeAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"session_id": "s1", "cwd": "/tmp/x", "hook_event_name": "SessionStart"})

    def test_rejects_missing_session_id(self):
        adapter = ClaudeCodeAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"cwd": "/tmp/x", "hook_event_name": "Stop"})

    def test_rejects_missing_cwd(self):
        adapter = ClaudeCodeAdapter()
        with pytest.raises(AdapterValidationError):
            adapter.to_event_input({"session_id": "s1", "hook_event_name": "Stop"})


def test_build_relay_command_quotes_path_with_spaces():
    command = build_relay_command("/path with spaces/taskswarm")
    assert "hooks claude-code-relay" in command
    assert "/path with spaces/taskswarm" in command
    # single-quoted shell-safe form
    assert command.startswith("'")


def test_install_claude_code_hooks_writes_project_settings(tmp_path):
    project_dir = str(tmp_path)
    result = install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/usr/local/bin/taskswarm"
    )
    assert result.changed is True
    assert result.settings_path == os.path.join(project_dir, ".claude", "settings.json")
    with open(result.settings_path, "r", encoding="utf-8") as handle:
        settings = json.load(handle)
    assert "Stop" in settings["hooks"]
    assert "Notification" in settings["hooks"]
    assert "/usr/local/bin/taskswarm" in settings["hooks"]["Stop"][0]["hooks"][0]["command"]


def test_install_claude_code_hooks_is_idempotent(tmp_path):
    project_dir = str(tmp_path)
    first = install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/usr/local/bin/taskswarm"
    )
    second = install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/usr/local/bin/taskswarm"
    )
    assert first.changed is True
    assert second.changed is False


def test_install_claude_code_hooks_repoints_on_path_change(tmp_path):
    project_dir = str(tmp_path)
    install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/old/path/taskswarm"
    )
    result = install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/new/path/taskswarm"
    )
    assert result.changed is True
    with open(result.settings_path, "r", encoding="utf-8") as handle:
        settings = json.load(handle)
    stop_hooks = settings["hooks"]["Stop"]
    # Old entry replaced, not duplicated.
    assert len(stop_hooks) == 1
    assert "/new/path/taskswarm" in stop_hooks[0]["hooks"][0]["command"]


def test_install_claude_code_hooks_preserves_unrelated_settings(tmp_path):
    project_dir = str(tmp_path)
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / "settings.json").write_text(json.dumps({"model": "some-model", "hooks": {}}))
    result = install_claude_code_hooks(
        scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/usr/local/bin/taskswarm"
    )
    with open(result.settings_path, "r", encoding="utf-8") as handle:
        settings = json.load(handle)
    assert settings["model"] == "some-model"


def test_install_claude_code_hooks_rejects_invalid_json(tmp_path):
    project_dir = str(tmp_path)
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    (claude_dir / "settings.json").write_text("{ not valid json")
    with pytest.raises(AdapterValidationError):
        install_claude_code_hooks(
            scope="project", project_dir=project_dir, home_dir=str(tmp_path), cli_script_path="/usr/local/bin/taskswarm"
        )


def test_install_claude_code_hooks_user_scope(tmp_path):
    home_dir = str(tmp_path)
    result = install_claude_code_hooks(
        scope="user", project_dir="/irrelevant", home_dir=home_dir, cli_script_path="/usr/local/bin/taskswarm"
    )
    assert result.settings_path == os.path.join(home_dir, ".claude", "settings.json")
