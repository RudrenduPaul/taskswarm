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


def test_fallback_strips_control_sequences(monkeypatch, capsys):
    import taskswarm.notifications.os_notify as mod

    monkeypatch.setattr(mod.platform, "system", lambda: "Linux")
    mod.send_os_notification("T\x1b[31mitle", "msg\x1b]0;evil\x07 ok\x1b]0;evil2\x1b\\ done")
    assert "[taskswarm] Title: msg ok done" in capsys.readouterr().out


def test_fallback_unterminated_osc_is_fast(monkeypatch, capsys):
    import time

    import taskswarm.notifications.os_notify as mod

    monkeypatch.setattr(mod.platform, "system", lambda: "Linux")
    start = time.monotonic()
    mod.send_os_notification("t", "\x1b]" * 50_000)
    assert time.monotonic() - start < 1.0
    capsys.readouterr()
