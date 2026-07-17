"""Plugin point every agent integration implements. An adapter's only job is
to normalize whatever raw, agent-specific payload it receives (a CLI flag
bag, a hook's stdin JSON, ...) into a schema-valid event-input dict. Ship
new integrations (Codex, Cursor, ...) by adding a new adapter here rather
than branching inside the server or CLI. Ported from src/adapters/types.ts."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict


class AdapterValidationError(Exception):
    pass


class AgentAdapter(ABC):
    agent_type: str
    name: str

    @abstractmethod
    def to_event_input(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Normalizes adapter-specific raw input into a schema-valid event input."""
        raise NotImplementedError
