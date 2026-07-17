"""In-memory event store keyed by session_id, backed by an append-only JSONL
log on disk for durability across restarts. No embedded database: this is a
deliberate choice to keep the tool lightweight, dependency-free, and
ARM-friendly (no native binary compile step). Ported from
src/server/event-store.ts.

Thread safety: the HTTP server (server/http_server.py) runs each connection
on its own thread (`http.server.ThreadingHTTPServer`), so every method here
that touches `_sessions` or the on-disk log is guarded by a single lock.
"""
from __future__ import annotations

import json
import os
import stat
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

from ..schema.events import AgentEvent, parse_agent_event

# Longest raw line content ever echoed back in a corrupt-line warning.
_CORRUPT_LINE_PREVIEW_LIMIT = 200


@dataclass
class SessionState:
    session_id: str
    latest: AgentEvent
    history: List[AgentEvent] = field(default_factory=list)


class EventStore:
    """Emits to registered listeners whenever a new event lands, so the HTTP
    layer can fan it out to connected /live clients."""

    def __init__(self, log_path: Optional[str] = None, warn: Optional[Callable[[str], None]] = None) -> None:
        self._sessions: "dict[str, SessionState]" = {}
        self._log_path = log_path
        self._warn = warn or (lambda message: print(message, flush=True))
        self._listeners: List[Callable[[AgentEvent], None]] = []
        self._lock = threading.Lock()
        if self._log_path:
            self._ensure_log_file(self._log_path)
            self._replay(self._log_path)

    def _ensure_log_file(self, log_path: str) -> None:
        directory = os.path.dirname(log_path)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, mode=0o700, exist_ok=True)
        if not os.path.exists(log_path):
            fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            os.close(fd)

    def _replay(self, log_path: str) -> None:
        """Rebuilds in-memory state by replaying every line of the JSONL
        log. Corrupt/partial lines (e.g. a torn write from a crash
        mid-append) are skipped rather than failing startup entirely --
        durability is best-effort, not a hard guarantee for the last
        unflushed line -- but each skip is logged so a torn write or
        bit-rot is visible to the operator instead of silently erasing
        history."""
        with open(log_path, "r", encoding="utf-8") as handle:
            raw = handle.read()
        for line_number, line in enumerate(raw.split("\n"), start=1):
            if line.strip() == "":
                continue
            try:
                parsed = parse_agent_event(json.loads(line))
                self._apply_to_memory(parsed)
            except Exception:
                self._warn_corrupt_line(log_path, line_number, line)

    def _warn_corrupt_line(self, log_path: str, line_number: int, line: str) -> None:
        preview = (
            f"{line[:_CORRUPT_LINE_PREVIEW_LIMIT]}... (truncated, {len(line)} chars total)"
            if len(line) > _CORRUPT_LINE_PREVIEW_LIMIT
            else line
        )
        self._warn(f"taskswarm: skipping unparseable event on line {line_number} of {log_path}: {preview}")

    def _apply_to_memory(self, event: AgentEvent) -> None:
        existing = self._sessions.get(event.session_id)
        if existing:
            existing.history.append(event)
            existing.latest = event
        else:
            self._sessions[event.session_id] = SessionState(
                session_id=event.session_id, latest=event, history=[event]
            )

    def append(self, event: AgentEvent) -> "tuple[Optional[str], Optional[str]]":
        """Appends a validated event to the log (if persistence is enabled)
        and updates in-memory state. Returns (previous_status,
        previous_blocked_reason) for the session (both None if this is the
        session's first event) so callers can decide whether a state
        transition warrants a notification -- notification dedup keys on
        the (status, blocked_reason) pair together, not status alone, so
        both are needed."""
        with self._lock:
            previous = self._sessions.get(event.session_id)
            previous_status = previous.latest.status if previous else None
            previous_blocked_reason = previous.latest.blocked_reason if previous else None
            if self._log_path:
                with open(self._log_path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(event.to_dict()) + "\n")
                try:
                    os.chmod(self._log_path, 0o600)
                except OSError:
                    pass
            self._apply_to_memory(event)
            listeners = list(self._listeners)
        for listener in listeners:
            listener(event)
        return previous_status, previous_blocked_reason

    def get_session(self, session_id: str) -> Optional[SessionState]:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> List[SessionState]:
        """All tracked sessions' latest state, sorted most-recently-updated first."""
        with self._lock:
            sessions = list(self._sessions.values())
        return sorted(sessions, key=lambda s: s.latest.timestamp, reverse=True)

    def size(self) -> int:
        with self._lock:
            return len(self._sessions)

    def add_listener(self, listener: Callable[[AgentEvent], None]) -> None:
        with self._lock:
            self._listeners.append(listener)

    def remove_listener(self, listener: Callable[[AgentEvent], None]) -> None:
        with self._lock:
            if listener in self._listeners:
                self._listeners.remove(listener)
