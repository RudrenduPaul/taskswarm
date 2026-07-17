from taskswarm.notifications.dispatch import NotifyOptions, notify, should_notify
from taskswarm.schema.events import parse_agent_event_input, to_agent_event


def _event(status="blocked", blocked_reason=None):
    data = {"session_id": "s1", "repo": "/tmp/x", "agent_type": "generic", "status": status}
    if blocked_reason:
        data["blocked_reason"] = blocked_reason
    return to_agent_event(parse_agent_event_input(data))


def test_should_notify_on_first_transition_into_notify_status():
    assert should_notify("blocked", None) is True


def test_should_notify_false_for_non_notify_statuses():
    assert should_notify("running", None) is False
    assert should_notify("queued", "running") is False


def test_should_notify_false_for_repeat_same_status_same_reason():
    assert should_notify("blocked", "blocked", "x", "x") is False


def test_should_notify_true_for_same_status_different_reason():
    assert should_notify("needs-review", "needs-review", "reason-a", "reason-b") is True


def test_should_notify_true_for_status_change():
    assert should_notify("failed", "running") is True


def test_notify_calls_os_notifier_on_qualifying_transition():
    calls = []
    options = NotifyOptions(os_notifier=lambda title, message: calls.append((title, message)))
    notify(_event(status="blocked", blocked_reason="waiting"), None, None, options)
    assert len(calls) == 1
    title, message = calls[0]
    assert title == "TaskSwarm: s1 blocked"
    assert "repo: /tmp/x" in message
    assert "reason: waiting" in message


def test_notify_skips_os_notifier_on_non_qualifying_transition():
    calls = []
    options = NotifyOptions(os_notifier=lambda title, message: calls.append((title, message)))
    notify(_event(status="running"), None, None, options)
    assert calls == []


def test_notify_skips_ntfy_when_disabled():
    ntfy_calls = []
    options = NotifyOptions(
        os_notifier=lambda t, m: None,
        ntfy=None,
        ntfy_sender=lambda url, t, m: ntfy_calls.append((url, t, m)),
    )
    notify(_event(status="failed"), None, None, options)
    assert ntfy_calls == []


def test_notify_fires_ntfy_when_enabled():
    import threading

    done = threading.Event()
    ntfy_calls = []

    def fake_sender(url, title, message):
        ntfy_calls.append((url, title, message))
        done.set()

    options = NotifyOptions(
        os_notifier=lambda t, m: None,
        ntfy={"enabled": True, "topicUrl": "https://ntfy.sh/my-topic"},
        ntfy_sender=fake_sender,
    )
    notify(_event(status="done"), None, None, options)
    assert done.wait(timeout=2), "ntfy sender was never called"
    assert ntfy_calls[0][0] == "https://ntfy.sh/my-topic"


def test_notify_ntfy_error_reported_via_callback():
    import threading

    done = threading.Event()
    errors = []

    def failing_sender(url, title, message):
        raise RuntimeError("network down")

    def on_error(error):
        errors.append(error)
        done.set()

    options = NotifyOptions(
        os_notifier=lambda t, m: None,
        ntfy={"enabled": True, "topicUrl": "https://ntfy.sh/my-topic"},
        ntfy_sender=failing_sender,
        on_ntfy_error=on_error,
    )
    notify(_event(status="done"), None, None, options)
    assert done.wait(timeout=2), "on_ntfy_error was never called"
    assert isinstance(errors[0], RuntimeError)
