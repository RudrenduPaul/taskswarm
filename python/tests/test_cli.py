import json
import threading

import pytest

from taskswarm.cli import run_cli
from taskswarm.notifications.dispatch import NotifyOptions
from taskswarm.server.config import TaskSwarmConfig, generate_token
from taskswarm.server.server import start_server


def _run(argv, capsys):
    exit_code = run_cli(["taskswarm", *argv])
    captured = capsys.readouterr()
    return exit_code, captured.out, captured.err


def test_version(capsys):
    with pytest.raises(SystemExit):
        run_cli(["taskswarm", "--version"])


def test_help_with_no_command(capsys):
    exit_code, out, err = _run([], capsys)
    assert exit_code == 0
    assert "taskswarm" in out


def test_task_add_and_list_json(capsys, isolated_taskswarm_home):
    exit_code, out, _ = _run(["task", "add", "--title", "Fix bug", "--repo", "./api", "--json"], capsys)
    assert exit_code == 0
    record = json.loads(out)
    assert record["title"] == "Fix bug"
    assert record["repo"] == "./api"

    exit_code, out, _ = _run(["task", "list", "--json"], capsys)
    assert exit_code == 0
    rows = json.loads(out)
    assert len(rows) == 1
    assert rows[0]["status"] == "unknown"  # no server reachable


def test_task_list_human_format_empty(capsys, isolated_taskswarm_home):
    exit_code, out, _ = _run(["task", "list"], capsys)
    assert exit_code == 0
    assert "No tasks yet" in out


def test_task_add_human_format(capsys, isolated_taskswarm_home):
    exit_code, out, _ = _run(["task", "add", "--title", "My task", "--repo", "/tmp/repo"], capsys)
    assert exit_code == 0
    assert "Task created:" in out
    assert "My task" in out


def test_agent_report_status_no_server_json(capsys, isolated_taskswarm_home):
    exit_code, out, err = _run(
        ["agent", "report-status", "--task", "t1", "--repo", "/tmp/x", "--state", "blocked", "--json"], capsys
    )
    assert exit_code == 1
    body = json.loads(out)
    assert "could not reach" in body["error"]


def test_agent_report_status_no_server_human(capsys, isolated_taskswarm_home):
    exit_code, out, err = _run(
        ["agent", "report-status", "--task", "t1", "--repo", "/tmp/x", "--state", "blocked"], capsys
    )
    assert exit_code == 1
    assert "Error:" in err


def test_agent_report_status_invalid_state_exits_2(capsys, isolated_taskswarm_home):
    with pytest.raises(SystemExit) as exc:
        run_cli(["taskswarm", "agent", "report-status", "--task", "t1", "--repo", "/tmp/x", "--state", "bogus"])
    assert exc.value.code == 2


def test_token_rotate_json(capsys, isolated_taskswarm_home):
    exit_code, out, _ = _run(["token", "rotate", "--json"], capsys)
    assert exit_code == 0
    body = json.loads(out)
    assert len(body["token"]) > 10


def test_hooks_install_unknown_adapter(capsys, isolated_taskswarm_home):
    exit_code, out, err = _run(["hooks", "install", "not-a-real-adapter", "--json"], capsys)
    assert exit_code == 1
    body = json.loads(out)
    assert "unknown adapter" in body["error"]


def test_hooks_install_claude_code(capsys, isolated_taskswarm_home, tmp_path):
    exit_code, out, _ = _run(
        ["hooks", "install", "claude-code", "--project-dir", str(tmp_path), "--json"], capsys
    )
    assert exit_code == 0
    result = json.loads(out)
    assert result["changed"] is True
    settings_path = tmp_path / ".claude" / "settings.json"
    assert settings_path.exists()


def test_hooks_claude_code_relay_reports_event(capsys, isolated_taskswarm_home, monkeypatch):
    config = TaskSwarmConfig(token=generate_token(), port=0, host="127.0.0.1")
    running = start_server(config=config, log_path=None, notify_options=NotifyOptions(os_notifier=lambda t, m: None))
    try:
        # Point the CLI at the already-running ephemeral-port server by
        # writing its config to the isolated TASKSWARM_HOME.
        from taskswarm.server.config import save_config

        save_config(running.config)

        payload = json.dumps(
            {"session_id": "relay-1", "cwd": "/tmp/proj", "hook_event_name": "Stop"}
        )
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(payload))
        exit_code, out, err = _run(["hooks", "claude-code-relay"], capsys)
        assert exit_code == 0
        assert err == ""

        from taskswarm.client.api_client import get_sessions

        sessions = get_sessions(running.config.to_dict())
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "relay-1"
        assert sessions[0]["latest"]["status"] == "done"
    finally:
        running.close()


def test_hooks_claude_code_relay_never_fails_hard(capsys, isolated_taskswarm_home, monkeypatch):
    """Even malformed stdin (no server running, bad JSON) must exit 0 -- a
    relay failure must never interrupt the Claude Code session."""
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("not valid json"))
    exit_code, out, err = _run(["hooks", "claude-code-relay"], capsys)
    assert exit_code == 0
    assert "taskswarm hook relay:" in err
