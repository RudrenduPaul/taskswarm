import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sleepSyncMs } from '../util/sync-sleep.js';

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
 * Attempts to create the config file exclusively (fails with EEXIST if
 * another process already created it). Returns true if this call won the
 * race and wrote the file, false if another process got there first.
 * Exported (in addition to being used internally by loadOrCreateConfig) so
 * the TOCTOU-loss path -- "we lost the race, and must never clobber the
 * winner's file" -- can be exercised directly and deterministically in
 * tests, without needing to fake real multi-process OS scheduling.
 */
export function tryCreateConfigExclusive(config: TaskSwarmConfig): boolean {
  ensureHomeDir();
  const path = getConfigPath();
  try {
    // 'wx' = O_CREAT|O_EXCL: atomically fails instead of overwriting if the
    // file already exists, so two racing first-boot processes can never
    // both "win" and clobber each other's token.
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort, see ensureHomeDir
  }
  return true;
}

/**
 * Reads and parses the config file, retrying briefly on a parse failure.
 * Guards the narrow window where we lost the exclusive-create race (see
 * tryCreateConfigExclusive) and the winning process has created the file
 * but not yet finished flushing its contents.
 */
function readConfigFileWithRetry(path: string): Partial<TaskSwarmConfig> {
  const maxAttempts = 25;
  const retryDelayMs = 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as Partial<TaskSwarmConfig>;
    } catch (error) {
      lastError = error;
      sleepSyncMs(retryDelayMs);
    }
  }
  throw lastError;
}

/**
 * Loads the config, creating it (with a freshly generated token) on first run.
 * The config file is created with 0600 permissions since it holds the bearer
 * token that gates the local HTTP API.
 *
 * First-boot creation is race-safe: if two processes both see no config
 * file and race to create one, exactly one of them wins the exclusive
 * create (see tryCreateConfigExclusive) and the loser re-reads the
 * winner's file instead of generating and persisting a second, different
 * token -- otherwise the server would end up serving one token while disk
 * holds another, and every subsequent CLI call would get a silent 401
 * until restart.
 */
export function loadOrCreateConfig(): TaskSwarmConfig {
  ensureHomeDir();
  const path = getConfigPath();
  if (!existsSync(path)) {
    const config = defaultConfig();
    if (tryCreateConfigExclusive(config)) {
      return config;
    }
    // Lost the race: another process already created the file first. Fall
    // through and read what it wrote rather than clobbering it.
  }
  const parsed = readConfigFileWithRetry(path);
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
