"""Bearer-token comparison and extraction. Ported from src/server/auth.ts."""
from __future__ import annotations

import hmac
from typing import Optional

_BEARER_SCHEME = "bearer"


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
    # Linear-time parse (no backtracking regex): scheme, at least one
    # whitespace character, then a non-empty single-line token.
    if len(authorization_header) <= len(_BEARER_SCHEME):
        return None
    if authorization_header[: len(_BEARER_SCHEME)].lower() != _BEARER_SCHEME:
        return None
    rest = authorization_header[len(_BEARER_SCHEME) :]
    token = rest.lstrip()
    if len(token) == len(rest) or not token:
        return None
    if any(ch in token for ch in ("\r", "\n", "\u2028", "\u2029")):
        return None
    return token
