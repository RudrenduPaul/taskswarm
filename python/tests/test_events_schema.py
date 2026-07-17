import pytest

from taskswarm.schema.events import (
    AGENT_STATUSES,
    AGENT_TYPES,
    CURRENT_SCHEMA_VERSION,
    NOTIFY_ON_STATUSES,
    EventValidationError,
    parse_agent_event,
    parse_agent_event_input,
    to_agent_event,
)


def _valid_input(**overrides):
    base = {"session_id": "s1", "repo": "/tmp/x", "agent_type": "generic", "status": "running"}
    base.update(overrides)
    return base


def test_agent_types_and_statuses_match_reference():
    assert AGENT_TYPES == ("claude-code", "codex", "cursor", "generic")
    assert AGENT_STATUSES == ("queued", "running", "blocked", "needs-review", "done", "failed")


def test_notify_on_statuses():
    assert NOTIFY_ON_STATUSES == {"blocked", "needs-review", "failed", "done"}
    assert "running" not in NOTIFY_ON_STATUSES
    assert "queued" not in NOTIFY_ON_STATUSES


def test_parse_agent_event_input_minimal_valid():
    parsed = parse_agent_event_input(_valid_input())
    assert parsed["session_id"] == "s1"
    assert parsed["repo"] == "/tmp/x"
    assert parsed["agent_type"] == "generic"
    assert parsed["status"] == "running"
    assert "event_id" not in parsed
    assert "blocked_reason" not in parsed


def test_parse_agent_event_input_rejects_missing_session_id():
    with pytest.raises(EventValidationError) as exc:
        parse_agent_event_input(_valid_input(session_id=""))
    assert "session_id" in exc.value.details


def test_parse_agent_event_input_rejects_bad_status():
    with pytest.raises(EventValidationError) as exc:
        parse_agent_event_input(_valid_input(status="not-a-status"))
    assert "status" in exc.value.details


def test_parse_agent_event_input_rejects_bad_agent_type():
    with pytest.raises(EventValidationError) as exc:
        parse_agent_event_input(_valid_input(agent_type="not-a-type"))
    assert "agent_type" in exc.value.details


def test_parse_agent_event_input_rejects_oversized_session_id():
    with pytest.raises(EventValidationError):
        parse_agent_event_input(_valid_input(session_id="x" * 257))


def test_parse_agent_event_input_rejects_oversized_blocked_reason():
    with pytest.raises(EventValidationError):
        parse_agent_event_input(_valid_input(blocked_reason="x" * 4097))


def test_parse_agent_event_input_rejects_bad_event_id():
    with pytest.raises(EventValidationError) as exc:
        parse_agent_event_input(_valid_input(event_id="not-a-uuid"))
    assert "event_id" in exc.value.details


def test_parse_agent_event_input_rejects_bad_timestamp():
    with pytest.raises(EventValidationError) as exc:
        parse_agent_event_input(_valid_input(timestamp="not-a-timestamp"))
    assert "timestamp" in exc.value.details


def test_parse_agent_event_input_accepts_offset_and_z_timestamps():
    parsed_z = parse_agent_event_input(_valid_input(timestamp="2026-01-01T00:00:00Z"))
    parsed_offset = parse_agent_event_input(_valid_input(timestamp="2026-01-01T00:00:00+05:00"))
    assert parsed_z["timestamp"] == "2026-01-01T00:00:00Z"
    assert parsed_offset["timestamp"] == "2026-01-01T00:00:00+05:00"


def test_parse_agent_event_input_rejects_naive_datetime():
    with pytest.raises(EventValidationError):
        parse_agent_event_input(_valid_input(timestamp="2026-01-01T00:00:00"))


def test_parse_agent_event_input_not_a_dict():
    with pytest.raises(EventValidationError):
        parse_agent_event_input("not a dict")  # type: ignore[arg-type]


def test_to_agent_event_fills_defaults():
    validated = parse_agent_event_input(_valid_input())
    event = to_agent_event(validated)
    assert event.session_id == "s1"
    assert event.schema_version == CURRENT_SCHEMA_VERSION
    assert event.event_id is not None
    assert event.timestamp.endswith("Z")
    assert event.blocked_reason is None


def test_to_agent_event_preserves_explicit_fields():
    validated = parse_agent_event_input(
        _valid_input(event_id="11111111-1111-1111-1111-111111111111", timestamp="2026-01-01T00:00:00Z", schema_version=1)
    )
    event = to_agent_event(validated)
    assert event.event_id == "11111111-1111-1111-1111-111111111111"
    assert event.timestamp == "2026-01-01T00:00:00Z"


def test_agent_event_to_dict_omits_none_blocked_reason():
    validated = parse_agent_event_input(_valid_input())
    event = to_agent_event(validated)
    data = event.to_dict()
    assert "blocked_reason" not in data
    assert data["status"] == "running"


def test_agent_event_to_dict_includes_blocked_reason_when_present():
    validated = parse_agent_event_input(_valid_input(status="blocked", blocked_reason="waiting"))
    event = to_agent_event(validated)
    data = event.to_dict()
    assert data["blocked_reason"] == "waiting"


def test_parse_agent_event_requires_all_stamped_fields():
    validated = parse_agent_event_input(_valid_input())
    event = to_agent_event(validated)
    reparsed = parse_agent_event(event.to_dict())
    assert reparsed.event_id == event.event_id
    assert reparsed.status == event.status


def test_parse_agent_event_rejects_missing_schema_version():
    validated = parse_agent_event_input(_valid_input())
    event = to_agent_event(validated)
    data = event.to_dict()
    del data["schema_version"]
    with pytest.raises(EventValidationError):
        parse_agent_event(data)
