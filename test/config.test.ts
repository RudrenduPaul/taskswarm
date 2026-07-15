import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateConfig,
  rotateToken,
  getConfigPath,
  getEventLogPath,
  generateToken,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from '../src/server/config.js';

describe('config', () => {
  let dir: string;
  const originalHome = process.env['TASKSWARM_HOME'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskswarm-home-'));
    process.env['TASKSWARM_HOME'] = dir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['TASKSWARM_HOME'];
    } else {
      process.env['TASKSWARM_HOME'] = originalHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a sufficiently long, random token', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('creates a config file with defaults on first run', () => {
    expect(existsSync(getConfigPath())).toBe(false);
    const config = loadOrCreateConfig();
    expect(existsSync(getConfigPath())).toBe(true);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.ntfy.enabled).toBe(false);
    expect(config.token.length).toBeGreaterThan(0);
  });

  it('restricts the config file to user-only permissions', () => {
    loadOrCreateConfig();
    if (platform() === 'win32') {
      return; // POSIX permission bits are not meaningful on Windows
    }
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses the same token across repeated loads', () => {
    const first = loadOrCreateConfig();
    const second = loadOrCreateConfig();
    expect(second.token).toBe(first.token);
  });

  it('rotates the token and persists the new value', () => {
    const before = loadOrCreateConfig();
    const rotated = rotateToken();
    expect(rotated).not.toBe(before.token);
    const after = loadOrCreateConfig();
    expect(after.token).toBe(rotated);
  });

  it('derives the event log path under the TaskSwarm home directory', () => {
    expect(getEventLogPath()).toBe(join(dir, 'events.jsonl'));
  });
});
