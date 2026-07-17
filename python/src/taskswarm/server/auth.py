"""Bearer-token comparison and extraction. Ported from src/server/auth.ts."""
from __future__ import annotations

import hmac
import re
from typing import Optional

_BEARER_RE = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)


def tokens_match(provided: str, expected: str) -> bool:
    """Constant-time comparison of two bearer tokens (avoids timing
    side-channels). `hmac.compare_digest` is the stdlib's constant-time
    comparator -- the direct Python equivalent of Node's
    `crypto.timingSafeEqual`, and (like the TS version) it tolerates
    differing lengths without leaking length via early-exit timing."""
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def extract_bearer_token(authorization_header: Optional[str]) -> Optional[str]:
    """Extracts a bearer token from an Authorization header value, if present."""
    if not authorization_header:
        return None
    match = _BEARER_RE.match(authorization_header)
    return match.group(1) if match else None
