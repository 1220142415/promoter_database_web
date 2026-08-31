from __future__ import annotations

import hashlib
import hmac
import secrets


def new_access_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(token: str, digest: str | None) -> bool:
    if not token or not digest:
        return False
    return hmac.compare_digest(token_digest(token), digest)
