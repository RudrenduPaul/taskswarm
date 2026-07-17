"""The wrapper-script fallback any agent (Codex, Cursor, or anything else
without a dedicated adapter) can use. This is the real, always-works
integration path in v0.1: a wrapper script around any coding-agent CLI calls
`taskswarm agent report-status --task <id> --repo <path> --state <status>`
at the points it cares about, which flows through this adapter. Ported from
src/adapters/generic-adapter.ts."""
from __future__ import annotations

from typing import Any, Dict

from ..schema.events import AGENT_STATUSES, AGENT_TYPES
from .types import AdapterValidationError, AgentAdapter


class GenericAdapter(AgentAdapter):
    agent_type = "generic"
    name = "Generic wrapper-script adapter"

    def to_event_input(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        session_id = raw.get("session_id")
        repo = raw.get("repo")
        status = raw.get("status")
        blocked_reason = raw.get("blocked_reason")
        agent_type_raw = raw.get("agent_type", "generic")

        if not isinstance(session_id, str) or len(session_id) == 0:
            raise AdapterValidationError("session_id is required")
        if not isinstance(repo, str) or len(repo) == 0:
            raise AdapterValidationError("repo is required")
        if not isinstance(status, str) or status not in AGENT_STATUSES:
            raise AdapterValidationError(f"status must be one of: {', '.join(AGENT_STATUSES)}")
        if not isinstance(agent_type_raw, str) or agent_type_raw not in AGENT_TYPES:
            raise AdapterValidationError(f"agent_type must be one of: {', '.join(AGENT_TYPES)}")

        input_data: Dict[str, Any] = {
            "session_id": session_id,
            "repo": repo,
            "agent_type": agent_type_raw,
            "status": status,
        }
        if isinstance(blocked_reason, str) and len(blocked_reason) > 0:
            input_data["blocked_reason"] = blocked_reason
        return input_data
