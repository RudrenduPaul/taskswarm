import os
import threading

from taskswarm.client.tasks_registry import TaskRecord, add_task, get_tasks_registry_path, list_tasks


def _record(task_id="t1", title="Fix bug", repo="/tmp/repo"):
    return TaskRecord(id=task_id, title=title, repo=repo, created_at="2026-01-01T00:00:00Z")


def test_list_tasks_empty_when_no_file(isolated_taskswarm_home):
    assert list_tasks() == []


def test_add_task_then_list(isolated_taskswarm_home):
    add_task(_record())
    tasks = list_tasks()
    assert len(tasks) == 1
    assert tasks[0]["id"] == "t1"
    assert tasks[0]["title"] == "Fix bug"


def test_add_multiple_tasks_appends(isolated_taskswarm_home):
    add_task(_record(task_id="t1"))
    add_task(_record(task_id="t2"))
    tasks = list_tasks()
    assert [t["id"] for t in tasks] == ["t1", "t2"]


def test_registry_file_written_with_owner_only_permissions(isolated_taskswarm_home):
    add_task(_record())
    mode = os.stat(get_tasks_registry_path()).st_mode & 0o777
    assert mode == 0o600


def test_concurrent_add_task_never_drops_a_write(isolated_taskswarm_home):
    """Regression test for the read-modify-write race documented in
    tasks_registry.py: N threads adding tasks concurrently must all survive
    -- none silently overwritten by a racing writer."""
    n = 12
    barrier = threading.Barrier(n)

    def worker(i):
        barrier.wait()
        add_task(_record(task_id=f"t{i}"))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    tasks = list_tasks()
    assert len(tasks) == n
    assert {t["id"] for t in tasks} == {f"t{i}" for i in range(n)}


def test_stale_lock_is_reclaimed(isolated_taskswarm_home):
    from taskswarm.client import tasks_registry as mod

    path = get_tasks_registry_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock_path = mod._lock_path_for(path)
    fd = os.open(lock_path, os.O_CREAT | os.O_WRONLY)
    os.close(fd)
    # Backdate the lock file so it looks abandoned by a crashed process.
    stale_time = os.path.getmtime(lock_path) - 20
    os.utime(lock_path, (stale_time, stale_time))

    add_task(_record())
    assert list_tasks()[0]["id"] == "t1"
    assert not os.path.exists(lock_path)
