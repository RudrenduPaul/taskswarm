"""Decides whether a status transition warrants a notification, and fires
the enabled channels. Ported from src/notify/index.ts."""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from ..schema.events import AgentEvent, NOTIFY_ON_STATUSES
from .ntfy import send_ntfy_notification
from .os_notify import send_os_notification


@dataclass
class NotifyOptions:
    ntfy: Optional[Dict[str, Any]] = None
    # Injectable for tests; defaults to the real OS notifier.
    os_notifier: Optional[Callable[[str, str], None]] = None
    # Injectable for tests; defaults to the real ntfy.sh sender.
    ntfy_sender: Optional[Callable[[str, str, str], None]] = None
    # Called whenever the ntfy channel raises, so failures never crash the server.
    on_ntfy_error: Optional[Callable[[BaseException], None]] = None


def should_notify(
    status: str,
    previous_status: Optional[str],
    blocked_reason: Optional[str] = None,
    previous_blocked_reason: Optional[str] = None,
) -> bool:
    """True if a transition from `previous_status`/`previous_blocked_reason`
    to `status`/`blocked_reason` should notify.

    Dedup keys on the (status, blocked_reason) pair, not status alone: two
    different permission prompts in a row are both 'needs-review', and two
    distinct idle nudges in a row are both 'blocked', but each carries a
    different (or newly-present) blocked_reason and is a genuinely new event
    a human should see -- not a duplicate to swallow. Only a same-status
    event whose blocked_reason also didn't change is treated as a repeat."""
    if status not in NOTIFY_ON_STATUSES:
        return False
    if status != previous_status:
        return True
    return blocked_reason != previous_blocked_reason


def _format_message(event: AgentEvent) -> "tuple[str, str]":
    title = f"TaskSwarm: {event.session_id} {event.status}"
    parts = [f"repo: {event.repo}", f"agent: {event.agent_type}"]
    if event.blocked_reason:
        parts.append(f"reason: {event.blocked_reason}")
    return title, " | ".join(parts)


def notify(
    event: AgentEvent,
    previous_status: Optional[str],
    previous_blocked_reason: Optional[str],
    options: Optional[NotifyOptions] = None,
) -> None:
    """Evaluates an event against its session's previous status/
    blocked_reason and fires the enabled notification channels if the
    transition warrants it. Local OS notification is always-on; ntfy.sh
    only fires when explicitly opted in."""
    options = options or NotifyOptions()
    if not should_notify(event.status, previous_status, event.blocked_reason, previous_blocked_reason):
        return

    title, message = _format_message(event)
    os_notifier = options.os_notifier or send_os_notification
    os_notifier(title, message)

    ntfy_config = options.ntfy or {}
    if ntfy_config.get("enabled") and ntfy_config.get("topicUrl"):
        ntfy_sender = options.ntfy_sender or send_ntfy_notification

        def _fire() -> None:
            try:
                ntfy_sender(ntfy_config["topicUrl"], title, message)
            except Exception as error:  # noqa: BLE001 -- notification channel must never raise into the caller
                if options.on_ntfy_error:
                    options.on_ntfy_error(error)

        # Fire-and-forget, same as the TS version's un-awaited
        # `ntfySender(...).catch(...)`: the network call to ntfy.sh must
        # never block the HTTP response path for the /events POST that
        # triggered it.
        threading.Thread(target=_fire, daemon=True).start()
