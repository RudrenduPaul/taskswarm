import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getTaskSwarmHome } from '../server/config.js';

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

export function addTask(record: TaskRecord): void {
  const path = getTasksRegistryPath();
  ensureHomeDir(path);
  const tasks = listTasks();
  tasks.push(record);
  writeFileSync(path, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
}
