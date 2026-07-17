import json
import os
import threading

from taskswarm.server.config import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    generate_token,
    get_config_path,
    get_event_log_path,
    get_taskswarm_home,
    load_or_create_config,
    rotate_token,
    save_config,
    try_create_config_exclusive,
    TaskSwarmConfig,
)


def test_get_taskswarm_home_uses_env_var(isolated_taskswarm_home):
    assert get_taskswarm_home() == isolated_taskswarm_home


def test_generate_token_is_random_and_nonempty():
    a = generate_token()
    b = generate_token()
    assert a != b
    assert len(a) > 20


def test_load_or_create_config_first_run_creates_file(isolated_taskswarm_home):
    assert not os.path.exists(get_config_path())
    config = load_or_create_config()
    assert os.path.exists(get_config_path())
    assert config.port == DEFAULT_PORT
    assert config.host == DEFAULT_HOST
    assert config.ntfy["enabled"] is False


def test_load_or_create_config_second_call_reuses_token(isolated_taskswarm_home):
    first = load_or_create_config()
    second = load_or_create_config()
    assert first.token == second.token


def test_config_file_written_with_owner_only_permissions(isolated_taskswarm_home):
    load_or_create_config()
    mode = os.stat(get_config_path()).st_mode & 0o777
    assert mode == 0o600


def test_save_config_persists_changes(isolated_taskswarm_home):
    config = load_or_create_config()
    config.port = 9999
    save_config(config)
    reloaded = load_or_create_config()
    assert reloaded.port == 9999


def test_rotate_token_changes_token_and_persists(isolated_taskswarm_home):
    original = load_or_create_config()
    new_token = rotate_token()
    assert new_token != original.token
    reloaded = load_or_create_config()
    assert reloaded.token == new_token


def test_try_create_config_exclusive_loses_race_when_file_exists(isolated_taskswarm_home):
    config_a = TaskSwarmConfig(token="token-a")
    config_b = TaskSwarmConfig(token="token-b")
    assert try_create_config_exclusive(config_a) is True
    assert try_create_config_exclusive(config_b) is False
    with open(get_config_path(), "r", encoding="utf-8") as handle:
        on_disk = json.load(handle)
    assert on_disk["token"] == "token-a"


def test_concurrent_first_boot_never_produces_two_tokens(isolated_taskswarm_home):
    """Regression test for the TOCTOU race documented in config.py:
    multiple threads racing to first-boot-create the config must all agree
    on exactly one token afterward."""
    results = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        results.append(load_or_create_config().token)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(set(results)) == 1, f"expected a single agreed-upon token, got {set(results)}"


def test_get_event_log_path_lives_under_home(isolated_taskswarm_home):
    assert get_event_log_path() == os.path.join(isolated_taskswarm_home, "events.jsonl")


def test_load_or_create_config_fills_missing_fields_on_old_config(isolated_taskswarm_home):
    os.makedirs(isolated_taskswarm_home, exist_ok=True)
    with open(get_config_path(), "w", encoding="utf-8") as handle:
        json.dump({"token": "legacy-token"}, handle)
    config = load_or_create_config()
    assert config.token == "legacy-token"
    assert config.port == DEFAULT_PORT
    assert config.host == DEFAULT_HOST
    assert config.ntfy["enabled"] is False
