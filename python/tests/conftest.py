import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def isolated_taskswarm_home(monkeypatch):
    """Every test gets its own TASKSWARM_HOME, so config/log/registry state
    never leaks between tests or touches the real ~/.taskswarm on the
    machine running the suite."""
    home = tempfile.mkdtemp(prefix="taskswarm-test-")
    monkeypatch.setenv("TASKSWARM_HOME", home)
    yield home
