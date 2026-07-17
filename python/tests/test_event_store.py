import json
import os

import pytest

from taskswarm.schema.events import parse_agent_event_input, to_agent_event
from taskswarm.server.event_store import EventStore


def _event(session_id="s1", status="running", **overrides):
    data = {"session_id": session_id, "repo": "/tmp/x", "agent_type": "generic", "status": status}
    data.update(overrides)
    return to_agent_event(parse_agent_event_input(data))


def test_append_and_get_session_no_persistence():
    store = EventStore()
    event = _event()
    previous_status, previous_reason = store.append(event)
    assert previous_status is None
    assert previous_reason is None
    session = store.get_session("s1")
    assert session.latest.status == "running"
    assert len(session.history) == 1


def test_append_returns_previous_status_on_second_event():
    store = EventStore()
    store.append(_event(status="running"))
    previous_status, previous_reason = store.append(_event(status="blocked", blocked_reason="waiting"))
    assert previous_status == "running"
    assert previous_reason is None


def test_list_sessions_sorted_most_recent_first():
    store = EventStore()
    store.append(_event(session_id="a", timestamp="2026-01-01T00:00:00Z"))
    store.append(_event(session_id="b", timestamp="2026-01-02T00:00:00Z"))
    sessions = store.list_sessions()
    assert [s.session_id for s in sessions] == ["b", "a"]


def test_size_reflects_distinct_sessions():
    store = EventStore()
    store.append(_event(session_id="a"))
    store.append(_event(session_id="b"))
    store.append(_event(session_id="a", status="done"))
    assert store.size() == 2


def test_listener_fires_on_append():
    store = EventStore()
    received = []
    store.add_listener(received.append)
    event = _event()
    store.append(event)
    assert len(received) == 1
    assert received[0].event_id == event.event_id


def test_remove_listener_stops_delivery():
    store = EventStore()
    received = []
    store.add_listener(received.append)
    store.remove_listener(received.append)
    store.append(_event())
    assert received == []


def test_persists_to_jsonl_log(isolated_taskswarm_home):
    log_path = os.path.join(isolated_taskswarm_home, "events.jsonl")
    store = EventStore(log_path)
    store.append(_event())
    with open(log_path, "r", encoding="utf-8") as handle:
        lines = [line for line in handle.read().split("\n") if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["session_id"] == "s1"


def test_log_file_written_with_owner_only_permissions(isolated_taskswarm_home):
    log_path = os.path.join(isolated_taskswarm_home, "events.jsonl")
    store = EventStore(log_path)
    store.append(_event())
    mode = os.stat(log_path).st_mode & 0o777
    assert mode == 0o600


def test_replay_rebuilds_state_from_disk(isolated_taskswarm_home):
    log_path = os.path.join(isolated_taskswarm_home, "events.jsonl")
    store1 = EventStore(log_path)
    store1.append(_event(status="running"))
    store1.append(_event(status="done"))

    store2 = EventStore(log_path)
    session = store2.get_session("s1")
    assert session.latest.status == "done"
    assert len(session.history) == 2


def test_replay_skips_corrupt_lines_and_warns(isolated_taskswarm_home):
    log_path = os.path.join(isolated_taskswarm_home, "events.jsonl")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    good = _event()
    with open(log_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(good.to_dict()) + "\n")
        handle.write("{not valid json\n")

    warnings = []
    store = EventStore(log_path, warn=warnings.append)
    assert store.get_session("s1") is not None
    assert len(warnings) == 1
    assert "unparseable event" in warnings[0]
