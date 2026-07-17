import io
import json
import urllib.error

import pytest

from taskswarm.notifications.ntfy import send_ntfy_notification


class _FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_send_ntfy_notification_success(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=10):
        captured["url"] = request.full_url
        captured["headers"] = {k.lower(): v for k, v in request.headers.items()}
        captured["data"] = request.data
        return _FakeResponse(200)

    monkeypatch.setattr("taskswarm.notifications.ntfy.urllib.request.urlopen", fake_urlopen)
    send_ntfy_notification("https://ntfy.sh/my-topic", "Title", "Body")
    assert captured["url"] == "https://ntfy.sh/my-topic"
    assert captured["data"] == b"Body"
    assert captured["headers"]["title"] == "Title"


def test_send_ntfy_notification_raises_on_http_error(monkeypatch):
    def fake_urlopen(request, timeout=10):
        raise urllib.error.HTTPError(request.full_url, 500, "Internal Server Error", {}, io.BytesIO(b""))

    monkeypatch.setattr("taskswarm.notifications.ntfy.urllib.request.urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="500"):
        send_ntfy_notification("https://ntfy.sh/my-topic", "Title", "Body")


def test_send_ntfy_notification_raises_on_connection_error(monkeypatch):
    def fake_urlopen(request, timeout=10):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr("taskswarm.notifications.ntfy.urllib.request.urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="connection refused"):
        send_ntfy_notification("https://ntfy.sh/my-topic", "Title", "Body")
