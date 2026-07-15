import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  closeSync,
  openSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { addTask, listTasks, getTasksRegistryPath } from '../src/cli/tasks-registry.js';
import type { TaskRecord } from '../src/cli/tasks-registry.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const addTaskWorkerFixture = join(repoRoot, 'test', 'fixtures', 'add-task-worker.ts');

/** Runs the add-task-worker fixture (a single addTask() call) in a real child process. */
function addTaskInChildProcess(home: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [addTaskWorkerFixture, id], {
      cwd: repoRoot,
      env: { ...process.env, TASKSWARM_HOME: home },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`add-task-worker exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

describe('tasks-registry', () => {
  let home: string;
  const originalHome = process.env['TASKSWARM_HOME'];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'taskswarm-tasks-home-'));
    process.env['TASKSWARM_HOME'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['TASKSWARM_HOME'];
    } else {
      process.env['TASKSWARM_HOME'] = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('lists nothing before any task has been added', () => {
    expect(listTasks()).toEqual([]);
  });

  it('persists a single added task', () => {
    const record: TaskRecord = {
      id: 't1',
      title: 'Solo task',
      repo: '/repo/a',
      created_at: new Date().toISOString(),
    };
    addTask(record);
    expect(listTasks()).toEqual([record]);
  });

  it(
    'survives several concurrent addTask() calls without silently dropping any ' +
      '(regression: non-atomic read-modify-write used to leave only 1 of N)',
    async () => {
      const ids = ['a', 'b', 'c', 'd', 'e'];

      await Promise.all(ids.map((id) => addTaskInChildProcess(home, id)));

      const tasks = listTasks();
      expect(tasks).toHaveLength(ids.length);
      expect(new Set(tasks.map((t) => t.id))).toEqual(new Set(ids));

      // The file on disk must also be valid JSON containing every record --
      // not just what happens to be in memory for this process.
      const onDisk = JSON.parse(readFileSync(getTasksRegistryPath(), 'utf-8')) as TaskRecord[];
      expect(onDisk).toHaveLength(ids.length);
    },
    20000,
  );

  it('releases the lock after addTask() so a subsequent call is never blocked', () => {
    addTask({ id: '1', title: 'first', repo: '/repo/a', created_at: new Date().toISOString() });
    addTask({ id: '2', title: 'second', repo: '/repo/a', created_at: new Date().toISOString() });
    expect(listTasks()).toHaveLength(2);
  });

  it('self-heals: reclaims and proceeds through a stale lock left behind by a crashed process', () => {
    const registryPath = getTasksRegistryPath();
    mkdirSync(dirname(registryPath), { recursive: true });
    const lockPath = `${registryPath}.lock`;
    closeSync(openSync(lockPath, 'w'));
    // Backdate the lock well past the staleness threshold, simulating a
    // process that created the lock and then crashed before releasing it.
    const twentySecondsAgo = new Date(Date.now() - 20_000);
    utimesSync(lockPath, twentySecondsAgo, twentySecondsAgo);

    addTask({
      id: 'x',
      title: 'after stale lock',
      repo: '/repo/a',
      created_at: new Date().toISOString(),
    });

    expect(listTasks()).toHaveLength(1);
  });

  it('gives up with a clear error after timing out on a genuinely held (non-stale) lock', () => {
    const registryPath = getTasksRegistryPath();
    mkdirSync(dirname(registryPath), { recursive: true });
    const lockPath = `${registryPath}.lock`;
    closeSync(openSync(lockPath, 'w')); // freshly created: not stale

    expect(() =>
      addTask({
        id: 'y',
        title: 'never gets in',
        repo: '/repo/a',
        created_at: new Date().toISOString(),
      }),
    ).toThrow(/timed out waiting for the tasks registry lock/);
  }, 8000);
});
