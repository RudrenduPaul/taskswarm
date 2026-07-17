"""ntfy.sh channel -- explicitly opt-in only. Never called unless the caller
has an enabled ntfy config with a topic URL; TaskSwarm's "self-hosted by
default" claim depends on this never firing implicitly. Ported from
src/notify/ntfy.ts."""
from __future__ import annotations

import urllib.error
import urllib.request


def send_ntfy_notification(topic_url: str, title: str, message: str) -> None:
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
