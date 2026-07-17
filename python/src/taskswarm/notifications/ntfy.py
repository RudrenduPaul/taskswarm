"""ntfy.sh channel -- explicitly opt-in only. Never called unless the caller
has an enabled ntfy config with a topic URL; TaskSwarm's "self-hosted by
default" claim depends on this never firing implicitly. Ported from
src/notify/ntfy.ts."""
from __future__ import annotations

import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

_PRIVATE_OR_LINK_LOCAL_IPV4 = [
    re.compile(r"^10\."),
    re.compile(r"^172\.(1[6-9]|2\d|3[01])\."),
    re.compile(r"^192\.168\."),
    re.compile(r"^169\.254\."),  # includes cloud metadata endpoints, e.g. 169.254.169.254
    re.compile(r"^0\."),
]


def validate_ntfy_url(topic_url: str):
    """Rejects a topic URL that isn't https (unless it targets loopback,
    useful for a local self-hosted ntfy instance during testing) or that
    targets a private/link-local address -- guards against a misconfigured
    or tampered config.json silently sending event data in plaintext or to
    an internal/metadata endpoint."""
    parsed = urlparse(topic_url)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f'invalid ntfy topic URL: "{topic_url}"')
    hostname = parsed.hostname
    is_loopback = hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "https" and not is_loopback:
        raise ValueError(
            f'ntfy topic URL must use https:// (got "{parsed.scheme}") -- plaintext http:// '
            "is only allowed for a loopback host, to avoid sending notification content "
            "unencrypted over a network"
        )
    if not is_loopback and any(pattern.match(hostname) for pattern in _PRIVATE_OR_LINK_LOCAL_IPV4):
        raise ValueError(
            f'ntfy topic URL host "{hostname}" is a private/link-local address -- refusing to '
            "send notifications there by default"
        )
    return parsed


def send_ntfy_notification(topic_url: str, title: str, message: str) -> None:
    validate_ntfy_url(topic_url)
    request = urllib.request.Request(
        topic_url,
        data=message.encode("utf-8"),
        method="POST",
        headers={"Title": title, "Priority": "default"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status >= 400:
                raise RuntimeError(f"ntfy.sh notification failed: {response.status}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"ntfy.sh notification failed: {error.code} {error.reason}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"ntfy.sh notification failed: {error.reason}") from error
