"""Talks to the local TaskSwarm server over HTTP. Ported from
src/cli/api-client.ts. Uses only `urllib.request` -- no HTTP client
dependency, matching the zero-runtime-dependency goal of this package."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List


class ApiClientError(Exception):
    def __init__(self, message: str, context: Any = None) -> None:
        super().__init__(message)
        self.context = context


def _base_url(host: str, port: int) -> str:
    return f"http://{host}:{port}"


def post_event(config: Dict[str, Any], input_data: Dict[str, Any]) -> Dict[str, Any]:
    """POSTs an event to the local TaskSwarm server. Raises ApiClientError on any failure."""
    base_url = _base_url(config["host"], config["port"])
    request = urllib.request.Request(
        f"{base_url}/events",
        data=json.dumps(input_data).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['token']}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise ApiClientError(f"server rejected event ({error.code}): {body}") from error
    except urllib.error.URLError as error:
        raise ApiClientError(
            f"could not reach TaskSwarm server at {base_url} -- is it running? (`taskswarm start`)",
            error,
        ) from error


def get_sessions(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """GETs current session states from the local TaskSwarm server."""
    base_url = _base_url(config["host"], config["port"])
    request = urllib.request.Request(
        f"{base_url}/events",
        headers={"Authorization": f"Bearer {config['token']}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ApiClientError(f"server returned {error.code}") from error
    except urllib.error.URLError as error:
        raise ApiClientError(f"could not reach TaskSwarm server at {base_url}", error) from error
    return data.get("sessions", [])
