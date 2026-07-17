import io
import json
import urllib.error

import pytest

from taskswarm.client.api_client import ApiClientError, get_sessions, post_event


def _config(port=4173):
    return {"host": "127.0.0.1", "port": port, "token": "test-token"}


def test_post_event_success(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"session_id": "s1", "status": "running"}).encode("utf-8")

    def fake_urlopen(request, timeout=10):
        captured["url"] = request.full_url
        captured["headers"] = {k.lower(): v for k, v in request.headers.items()}
        captured["body"] = json.loads(request.data)
        return FakeResponse()

    monkeypatch.setattr("taskswarm.client.api_client.urllib.request.urlopen", fake_urlopen)
    result = post_event(_config(), {"session_id": "s1", "repo": "/tmp/x", "agent_type": "generic", "status": "running"})
    assert result["session_id"] == "s1"
    assert captured["url"] == "http://127.0.0.1:4173/events"
    assert captured["headers"]["authorization"] == "Bearer test-token"


def test_post_event_raises_on_connection_error(monkeypatch):
    def fake_urlopen(request, timeout=10):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr("taskswarm.client.api_client.urllib.request.urlopen", fake_urlopen)
    with pytest.raises(ApiClientError, match="could not reach"):
        post_event(_config(), {"session_id": "s1"})


def test_post_event_raises_on_http_error(monkeypatch):
    def fake_urlopen(request, timeout=10):
        raise urllib.error.HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(b'{"error":"invalid event"}'))

    monkeypatch.setattr("taskswarm.client.api_client.urllib.request.urlopen", fake_urlopen)
    with pytest.raises(ApiClientError, match="rejected event"):
        post_event(_config(), {"session_id": "s1"})


def test_get_sessions_success(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"sessions": [{"session_id": "s1"}]}).encode("utf-8")

    monkeypatch.setattr("taskswarm.client.api_client.urllib.request.urlopen", lambda req, timeout=10: FakeResponse())
    sessions = get_sessions(_config())
    assert sessions == [{"session_id": "s1"}]


def test_get_sessions_raises_on_connection_error(monkeypatch):
    def fake_urlopen(request, timeout=10):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr("taskswarm.client.api_client.urllib.request.urlopen", fake_urlopen)
    with pytest.raises(ApiClientError):
        get_sessions(_config())
