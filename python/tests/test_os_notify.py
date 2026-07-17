import platform

from taskswarm.notifications.os_notify import send_os_notification


def test_send_os_notification_does_not_raise():
    """Smoke test: on any platform (macOS via osascript, or the
    console/bell fallback elsewhere), sending a notification must never
    raise -- a broken notification channel must not crash the caller."""
    send_os_notification("Test title", "Test message")


def test_fallback_used_on_non_darwin(monkeypatch, capsys):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    import taskswarm.notifications.os_notify as mod

    monkeypatch.setattr(mod.platform, "system", lambda: "Linux")
    mod.send_os_notification("Hello", "World")
    captured = capsys.readouterr()
    assert "[taskswarm] Hello: World" in captured.out
