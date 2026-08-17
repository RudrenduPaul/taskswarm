"""
Public library surface. Most users will interact with TaskSwarm through the
CLI (`taskswarm`/`taskswarm-cli`); these exports exist for tooling that
wants to embed the event store, adapters, or server programmatically.

    from taskswarm import start_server, EventStore

This is the Python port of the taskswarm-cli npm package
(https://www.npmjs.com/package/taskswarm-cli). Both distributions ship the
same event schema, event-server behavior, and notification logic; see
https://github.com/RudrenduPaul/taskswarm for the canonical documentation
and the original TypeScript source.
"""
from importlib import metadata as _importlib_metadata

from .adapters.claude_code_adapter import ClaudeCodeAdapter, install_claude_code_hooks
from .adapters.generic_adapter import GenericAdapter
from .adapters.types import AdapterValidationError, AgentAdapter
from .notifications.dispatch import NotifyOptions, notify, should_notify
from .schema.events import (
    AGENT_STATUSES,
    AGENT_TYPES,
    CURRENT_SCHEMA_VERSION,
    NOTIFY_ON_STATUSES,
    AgentEvent,
    EventValidationError,
    to_agent_event,
)
from .server.config import (
    TaskSwarmConfig,
    generate_token,
    get_taskswarm_home,
    load_or_create_config,
    rotate_token,
    save_config,
)
from .server.event_store import EventStore, SessionState
from .server.server import RunningServer, start_server

try:
    # Read the version from the installed package's own metadata rather than
    # a hand-maintained string here, which silently drifted from the real
    # pyproject.toml version (this constant, and cli.py's separate
    # PACKAGE_VERSION constant, were still "0.1.0" and "0.1.1" respectively
    # while the package had shipped later versions on PyPI, so
    # `taskswarm --version` reported a stale, wrong version to every user and
    # agent that checked it).
    __version__ = _importlib_metadata.version("taskswarm-cli")
except _importlib_metadata.PackageNotFoundError:
    # Not installed (e.g. running straight from a source checkout without
    # `pip install -e .`) -- fall back to a clearly-labeled placeholder
    # instead of a number that can silently go stale again.
    __version__ = "0.0.0-dev"

__all__ = [
    "AGENT_STATUSES",
    "AGENT_TYPES",
    "CURRENT_SCHEMA_VERSION",
    "NOTIFY_ON_STATUSES",
    "AdapterValidationError",
    "AgentAdapter",
    "AgentEvent",
    "ClaudeCodeAdapter",
    "EventStore",
    "EventValidationError",
    "GenericAdapter",
    "NotifyOptions",
    "RunningServer",
    "SessionState",
    "TaskSwarmConfig",
    "generate_token",
    "get_taskswarm_home",
    "install_claude_code_hooks",
    "load_or_create_config",
    "notify",
    "rotate_token",
    "save_config",
    "should_notify",
    "start_server",
    "to_agent_event",
    "__version__",
]
