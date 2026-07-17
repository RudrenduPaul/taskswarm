"""Ported from src/util/sync-sleep.ts. The TS version needs a genuinely
blocking sleep (a plain `await sleep()` would yield to Node's event loop and
let other async work interleave with the retry loops in config.py /
tasks_registry.py that must run atomically with respect to a single
process). Python's `time.sleep` already blocks the calling thread without
yielding to anything else, so this wrapper exists only to keep the module
layout parallel to the TypeScript source and give the retry loops a single,
clearly-named call site."""
from __future__ import annotations

import time


def sleep_sync_ms(milliseconds: float) -> None:
    time.sleep(milliseconds / 1000.0)
