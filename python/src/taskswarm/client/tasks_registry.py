"""Local, server-independent registry of tasks the user has created via
`taskswarm task add`. TaskSwarm's wire schema (AgentEvent) is intentionally
generic and has no `title` field, so human-friendly titles live here rather
than on the server -- `task add` works even before the server has ever been
started. Ported from src/cli/tasks-registry.ts."""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List

from ..server.config import get_taskswarm_home
from ..util.sync_sleep import sleep_sync_ms


@dataclass
class TaskRecord:
    id: str
    title: str
    repo: str
    created_at: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def get_tasks_registry_path() -> str:
    return str(Path(get_taskswarm_home()) / "tasks.json")


def _ensure_home_dir(path: str) -> None:
    directory = os.path.dirname(path)
    if directory and not os.path.exists(directory):
        os.makedirs(directory, mode=0o700, exist_ok=True)


def list_tasks() -> List[Dict[str, Any]]:
    path = get_tasks_registry_path()
    if not os.path.exists(path):
        return []
    raw = Path(path).read_text(encoding="utf-8").strip()
    if len(raw) == 0:
        return []
    return json.loads(raw)


_LOCK_RETRY_DELAY_MS = 10
_LOCK_TIMEOUT_MS = 5000
# A lock older than this is assumed to be left behind by a crashed process.
_STALE_LOCK_MS = 10000


def _lock_path_for(registry_path: str) -> str:
    return f"{registry_path}.lock"


def _acquire_lock(lock_path: str) -> None:
    """Acquires an exclusive lock by atomically creating `lock_path`
    (O_CREAT|O_EXCL, so exactly one concurrent caller can win). Retries with
    backoff while the lock is held by someone else, reclaiming it if it
    looks abandoned (e.g. the holder crashed before releasing it) so a dead
    lock file can never wedge the CLI forever."""
    deadline = time.monotonic() + (_LOCK_TIMEOUT_MS / 1000.0)
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return
        except FileExistsError:
            try:
                age_ms = (time.time() - os.stat(lock_path).st_mtime) * 1000
                if age_ms > _STALE_LOCK_MS:
                    os.unlink(lock_path)
                    continue
            except FileNotFoundError:
                # Lock vanished between our EEXIST and this stat (the holder
                # just finished) -- loop around and try to acquire it again.
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"timed out waiting for the tasks registry lock at {lock_path} "
                    "(another taskswarm process may be stuck)"
                )
            sleep_sync_ms(_LOCK_RETRY_DELAY_MS)


def _release_lock(lock_path: str) -> None:
    try:
        os.unlink(lock_path)
    except FileNotFoundError:
        # best-effort: if it's already gone (e.g. reclaimed as stale by
        # another waiter) there's nothing left to release.
        pass


def add_task(record: TaskRecord) -> None:
    """Registers a new task. Guarded by a lockfile around the
    read-modify-write cycle so concurrent add_task() calls (e.g. several
    agent sessions starting at once) never race: without it, two callers
    can both read the same on-disk list, each append their own record in
    memory, and the second write silently overwrites the first caller's
    write, dropping a task with no error."""
    path = get_tasks_registry_path()
    _ensure_home_dir(path)
    lock_path = _lock_path_for(path)
    _acquire_lock(lock_path)
    try:
        tasks = list_tasks()
        tasks.append(record.to_dict())
        Path(path).write_text(json.dumps(tasks, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        _release_lock(lock_path)
