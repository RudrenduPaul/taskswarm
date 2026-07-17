"""
The event envelope every part of TaskSwarm agrees on.

Ported from src/schema/events.ts, which uses `zod` for runtime validation.
This port has zero runtime dependencies, so validation is hand-written here
instead of pulled in from a schema library -- the field set, limits, and
error shape are kept equivalent to the TypeScript version's
`agentEventSchema` / `agentEventInputSchema`.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# The current envelope version. Bump this whenever the shape of AgentEvent
# changes in a way that is not purely additive-and-optional. Consumers can
# branch on `schema_version` to stay forward compatible.
CURRENT_SCHEMA_VERSION = 1

# Agent integrations TaskSwarm ships an adapter for in v0.1.
AGENT_TYPES = ("claude-code", "codex", "cursor", "generic")

# Lifecycle states a tracked session can be in. TaskSwarm's notification
# layer fires on a transition into 'blocked' | 'needs-review' | 'failed' |
# 'done' -- the four states that mean "a human should look at this now."
AGENT_STATUSES = ("queued", "running", "blocked", "needs-review", "done", "failed")

# The subset of statuses that should trigger a notification on transition.
NOTIFY_ON_STATUSES = frozenset({"blocked", "needs-review", "failed", "done"})

_SESSION_ID_MAX = 256
_REPO_MAX = 1024
_BLOCKED_REASON_MAX = 4096

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


class EventValidationError(ValueError):
    """Raised when a raw dict does not satisfy the AgentEvent(Input) contract.

    `details` mirrors zod's `.flatten()` shape closely enough to be useful
    for a caller building a `400` response body: a dict of field name to a
    list of human-readable problem messages.
    """

    def __init__(self, message: str, details: Optional[Dict[str, List[str]]] = None) -> None:
        super().__init__(message)
        self.details: Dict[str, List[str]] = details or {}


@dataclass
class AgentEvent:
    event_id: str
    session_id: str
    repo: str
    agent_type: str
    status: str
    timestamp: str
    schema_version: int
    blocked_reason: Optional[str] = field(default=None)

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "event_id": self.event_id,
            "session_id": self.session_id,
            "repo": self.repo,
            "agent_type": self.agent_type,
            "status": self.status,
            "timestamp": self.timestamp,
            "schema_version": self.schema_version,
        }
        if self.blocked_reason is not None:
            data["blocked_reason"] = self.blocked_reason
        return data


def _is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(_UUID_RE.match(value))


def _is_offset_datetime(value: Any) -> bool:
    """True for an ISO-8601 datetime string carrying an explicit UTC offset
    (including a bare "Z"), matching zod's `z.string().datetime({offset:
    true})`."""
    if not isinstance(value, str) or len(value) == 0:
        return False
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _add_error(errors: Dict[str, List[str]], field_name: str, message: str) -> None:
    errors.setdefault(field_name, []).append(message)


def _validate_common(data: Dict[str, Any], errors: Dict[str, List[str]]) -> None:
    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not (1 <= len(session_id) <= _SESSION_ID_MAX):
        _add_error(errors, "session_id", f"must be a string of 1-{_SESSION_ID_MAX} characters")

    repo = data.get("repo")
    if not isinstance(repo, str) or not (1 <= len(repo) <= _REPO_MAX):
        _add_error(errors, "repo", f"must be a string of 1-{_REPO_MAX} characters")

    agent_type = data.get("agent_type")
    if agent_type not in AGENT_TYPES:
        _add_error(errors, "agent_type", f"must be one of: {', '.join(AGENT_TYPES)}")

    status = data.get("status")
    if status not in AGENT_STATUSES:
        _add_error(errors, "status", f"must be one of: {', '.join(AGENT_STATUSES)}")

    blocked_reason = data.get("blocked_reason")
    if blocked_reason is not None and (
        not isinstance(blocked_reason, str) or len(blocked_reason) > _BLOCKED_REASON_MAX
    ):
        _add_error(errors, "blocked_reason", f"must be a string of at most {_BLOCKED_REASON_MAX} characters")


def parse_agent_event_input(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validates the input shape accepted from the CLI/adapters/HTTP layer:
    event_id, timestamp, and schema_version are all optional (filled in by
    `to_agent_event`); everything else is required. Raises
    EventValidationError with field-level details on failure."""
    if not isinstance(data, dict):
        raise EventValidationError("event input must be a JSON object", {"_root": ["must be an object"]})

    errors: Dict[str, List[str]] = {}
    _validate_common(data, errors)

    event_id = data.get("event_id")
    if event_id is not None and not _is_uuid(event_id):
        _add_error(errors, "event_id", "must be a valid UUID")

    timestamp = data.get("timestamp")
    if timestamp is not None and not _is_offset_datetime(timestamp):
        _add_error(errors, "timestamp", "must be an ISO-8601 datetime with a UTC offset")

    schema_version = data.get("schema_version")
    if schema_version is not None and not (isinstance(schema_version, int) and schema_version > 0):
        _add_error(errors, "schema_version", "must be a positive integer")

    if errors:
        raise EventValidationError("invalid event", errors)

    result: Dict[str, Any] = {
        "session_id": data["session_id"],
        "repo": data["repo"],
        "agent_type": data["agent_type"],
        "status": data["status"],
    }
    if data.get("blocked_reason") is not None:
        result["blocked_reason"] = data["blocked_reason"]
    if event_id is not None:
        result["event_id"] = event_id
    if timestamp is not None:
        result["timestamp"] = timestamp
    if schema_version is not None:
        result["schema_version"] = schema_version
    return result


def parse_agent_event(data: Dict[str, Any]) -> AgentEvent:
    """Validates a fully-stamped event (all fields required) -- used when
    replaying persisted JSONL log lines, where every event must already
    carry event_id/timestamp/schema_version."""
    if not isinstance(data, dict):
        raise EventValidationError("event must be a JSON object")

    errors: Dict[str, List[str]] = {}
    _validate_common(data, errors)

    if not _is_uuid(data.get("event_id")):
        _add_error(errors, "event_id", "must be a valid UUID")
    if not _is_offset_datetime(data.get("timestamp")):
        _add_error(errors, "timestamp", "must be an ISO-8601 datetime with a UTC offset")
    schema_version = data.get("schema_version")
    if not (isinstance(schema_version, int) and schema_version > 0):
        _add_error(errors, "schema_version", "must be a positive integer")

    if errors:
        raise EventValidationError("invalid event", errors)

    return AgentEvent(
        event_id=data["event_id"],
        session_id=data["session_id"],
        repo=data["repo"],
        agent_type=data["agent_type"],
        status=data["status"],
        timestamp=data["timestamp"],
        schema_version=data["schema_version"],
        blocked_reason=data.get("blocked_reason"),
    )


def to_agent_event(input_data: Dict[str, Any]) -> AgentEvent:
    """Fills in event_id/timestamp/schema_version defaults for a partial,
    already-validated input (the output of parse_agent_event_input)."""
    event_id = input_data.get("event_id") or str(uuid.uuid4())
    timestamp = input_data.get("timestamp") or datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    schema_version = input_data.get("schema_version") or CURRENT_SCHEMA_VERSION
    return AgentEvent(
        event_id=event_id,
        session_id=input_data["session_id"],
        repo=input_data["repo"],
        agent_type=input_data["agent_type"],
        status=input_data["status"],
        timestamp=timestamp,
        schema_version=schema_version,
        blocked_reason=input_data.get("blocked_reason"),
    )
