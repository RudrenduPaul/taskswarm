import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TaskSwarmConfig {
  /** Bearer token clients must present to POST/GET /events and connect to /live. */
  token: string;
  /** Port the HTTP server listens on. */
  port: number;
  /** Host the HTTP server binds to. Defaults to loopback-only. */
  host: string;
  /** Opt-in: forward notifications to ntfy.sh. Off by default (self-hosted-by-default claim). */
  ntfy: {
    enabled: boolean;
    topicUrl?: string;
  };
}

export const DEFAULT_PORT = 4173;
export const DEFAULT_HOST = '127.0.0.1';

/** Root directory for all TaskSwarm local state. Overridable for tests via TASKSWARM_HOME. */
export function getTaskSwarmHome(): string {
  return process.env['TASKSWARM_HOME'] ?? join(homedir(), '.taskswarm');
}

export function getConfigPath(): string {
  return join(getTaskSwarmHome(), 'config.json');
}

export function getEventLogPath(): string {
  return join(getTaskSwarmHome(), 'events.jsonl');
}

/** Generates a cryptographically random bearer token (256 bits, url-safe). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function ensureHomeDir(): void {
  const home = getTaskSwarmHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(home, 0o700);
  } catch {
    // best-effort on platforms/filesystems that don't support POSIX perms (e.g. some CI images)
  }
}

function defaultConfig(): TaskSwarmConfig {
  return {
    token: generateToken(),
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    ntfy: { enabled: false },
  };
}

function writeConfig(config: TaskSwarmConfig): void {
  ensureHomeDir();
  const path = getConfigPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort, see ensureHomeDir
  }
}

/**
 * Loads the config, creating it (with a freshly generated token) on first run.
 * The config file is created with 0600 permissions since it holds the bearer
 * token that gates the local HTTP API.
 */
export function loadOrCreateConfig(): TaskSwarmConfig {
  ensureHomeDir();
  const path = getConfigPath();
  if (!existsSync(path)) {
    const config = defaultConfig();
    writeConfig(config);
    return config;
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<TaskSwarmConfig>;
  // Fill in any missing fields so older config files on disk stay valid after upgrades.
  const merged: TaskSwarmConfig = {
    token: parsed.token ?? generateToken(),
    port: parsed.port ?? DEFAULT_PORT,
    host: parsed.host ?? DEFAULT_HOST,
    ntfy: {
      enabled: parsed.ntfy?.enabled ?? false,
      ...(parsed.ntfy?.topicUrl !== undefined ? { topicUrl: parsed.ntfy.topicUrl } : {}),
    },
  };
  if (!parsed.token) {
    writeConfig(merged);
  }
  return merged;
}

export function saveConfig(config: TaskSwarmConfig): void {
  writeConfig(config);
}

/** Regenerates the bearer token and persists it. Returns the new token. */
export function rotateToken(): string {
  const config = loadOrCreateConfig();
  config.token = generateToken();
  writeConfig(config);
  return config.token;
}
