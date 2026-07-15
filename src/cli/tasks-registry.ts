import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getTaskSwarmHome } from '../server/config.js';
import { sleepSyncMs } from '../util/sync-sleep.js';

export interface TaskRecord {
  id: string;
  title: string;
  repo: string;
  created_at: string;
}

/**
 * Local, server-independent registry of tasks the user has created via
 * `taskswarm task add`. TaskSwarm's wire schema (AgentEvent) is
 * intentionally generic and has no `title` field, so human-friendly titles
 * live here rather than on the server -- `task add` works even before the
 * server has ever been started.
 */
export function getTasksRegistryPath(): string {
  return join(getTaskSwarmHome(), 'tasks.json');
}

function ensureHomeDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function listTasks(): TaskRecord[] {
  const path = getTasksRegistryPath();
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf-8').trim();
  if (raw.length === 0) {
    return [];
  }
  return JSON.parse(raw) as TaskRecord[];
}

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
/** A lock older than this is assumed to be left behind by a crashed process. */
const STALE_LOCK_MS = 10000;

function lockPathFor(registryPath: string): string {
  return `${registryPath}.lock`;
}

/**
 * Acquires an exclusive lock by atomically creating `lockPath` (O_CREAT |
 * O_EXCL, so exactly one concurrent caller can win). Retries with backoff
 * while the lock is held by someone else, reclaiming it if it looks
 * abandoned (e.g. the holder crashed before releasing it) so a dead lock
 * file can never wedge the CLI forever.
 */
function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between our EEXIST and this stat (the holder just
        // finished) -- loop around and try to acquire it again.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for the tasks registry lock at ${lockPath} ` +
            '(another taskswarm process may be stuck)',
        );
      }
      sleepSyncMs(LOCK_RETRY_DELAY_MS);
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort: if it's already gone (e.g. reclaimed as stale by another
    // waiter) there's nothing left to release.
  }
}

/**
 * Registers a new task. Guarded by a lockfile around the read-modify-write
 * cycle so concurrent `addTask()` calls (e.g. several agent sessions
 * starting at once) never race: without it, two callers can both read the
 * same on-disk list, each append their own record in memory, and the
 * second writeFileSync silently overwrites the first caller's write,
 * dropping a task with no error. `task add` is a local CLI invocation, not
 * a long-running server, so a simple exclusive-create lockfile (retried
 * with backoff, self-healing if abandoned) is a good fit -- no need for a
 * full append-only log like the server's event store.
 */
export function addTask(record: TaskRecord): void {
  const path = getTasksRegistryPath();
  ensureHomeDir(path);
  const lockPath = lockPathFor(path);
  acquireLock(lockPath);
  try {
    const tasks = listTasks();
    tasks.push(record);
    writeFileSync(path, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
  } finally {
    releaseLock(lockPath);
  }
}
