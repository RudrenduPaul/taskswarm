"""Local config: bearer token, host/port, and the opt-in ntfy.sh channel.
Ported from src/server/config.ts."""
from __future__ import annotations

import json
import os
import secrets
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from ..util.sync_sleep import sleep_sync_ms

DEFAULT_PORT = 4173
DEFAULT_HOST = "127.0.0.1"


@dataclass
class TaskSwarmConfig:
    token: str
    port: int = DEFAULT_PORT
    host: str = DEFAULT_HOST
    ntfy: Dict[str, Any] = field(default_factory=lambda: {"enabled": False})

    def to_dict(self) -> Dict[str, Any]:
        return {"token": self.token, "port": self.port, "host": self.host, "ntfy": self.ntfy}


def get_taskswarm_home() -> str:
    """Root directory for all TaskSwarm local state. Overridable for tests
    via TASKSWARM_HOME."""
    return os.environ.get("TASKSWARM_HOME") or str(Path.home() / ".taskswarm")


def get_config_path() -> str:
    return str(Path(get_taskswarm_home()) / "config.json")


def get_event_log_path() -> str:
    return str(Path(get_taskswarm_home()) / "events.jsonl")


def generate_token() -> str:
    """Generates a cryptographically random bearer token (256 bits, URL-safe)."""
    return secrets.token_urlsafe(32)


def _ensure_home_dir() -> None:
    home = Path(get_taskswarm_home())
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(home, 0o700)
    except OSError:
        # best-effort on platforms/filesystems that don't support POSIX perms
        pass


def _default_config() -> TaskSwarmConfig:
    return TaskSwarmConfig(token=generate_token(), port=DEFAULT_PORT, host=DEFAULT_HOST, ntfy={"enabled": False})


def _write_config(config: TaskSwarmConfig) -> None:
    _ensure_home_dir()
    path = get_config_path()
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(config.to_dict(), indent=2) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def try_create_config_exclusive(config: TaskSwarmConfig) -> bool:
    """Attempts to create the config file exclusively (fails if another
    process already created it). Returns True if this call won the race and
    wrote the file, False if another process got there first. Exported so
    the TOCTOU-loss path can be exercised directly and deterministically in
    tests, without needing to fake real multi-process OS scheduling."""
    _ensure_home_dir()
    path = get_config_path()
    payload = json.dumps(config.to_dict(), indent=2) + "\n"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(fd, payload.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return True


def _read_config_file_with_retry(path: str) -> Dict[str, Any]:
    """Reads and parses the config file, retrying briefly on a parse
    failure. Guards the narrow window where we lost the exclusive-create
    race and the winning process has created the file but not yet finished
    flushing its contents."""
    max_attempts = 25
    retry_delay_ms = 4
    last_error: Optional[Exception] = None
    for _ in range(max_attempts):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            last_error = error
            sleep_sync_ms(retry_delay_ms)
    assert last_error is not None
    raise last_error


def load_or_create_config() -> TaskSwarmConfig:
    """Loads the config, creating it (with a freshly generated token) on
    first run. First-boot creation is race-safe: if two processes both see
    no config file and race to create one, exactly one of them wins the
    exclusive create and the loser re-reads the winner's file instead of
    generating and persisting a second, different token."""
    _ensure_home_dir()
    path = get_config_path()
    if not os.path.exists(path):
        config = _default_config()
        if try_create_config_exclusive(config):
            return config
        # Lost the race: another process already created the file first.
        # Fall through and read what it wrote rather than clobbering it.

    parsed = _read_config_file_with_retry(path)
    ntfy = parsed.get("ntfy") or {}
    merged = TaskSwarmConfig(
        token=parsed.get("token") or generate_token(),
        port=parsed.get("port") or DEFAULT_PORT,
        host=parsed.get("host") or DEFAULT_HOST,
        ntfy={"enabled": bool(ntfy.get("enabled", False)), **({"topicUrl": ntfy["topicUrl"]} if ntfy.get("topicUrl") else {})},
    )
    if not parsed.get("token"):
        _write_config(merged)
    return merged


def save_config(config: TaskSwarmConfig) -> None:
    _write_config(config)


def rotate_token() -> str:
    """Regenerates the bearer token and persists it. Returns the new token."""
    config = load_or_create_config()
    config.token = generate_token()
    _write_config(config)
    return config.token
