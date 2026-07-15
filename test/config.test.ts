import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadOrCreateConfig,
  rotateToken,
  getConfigPath,
  getEventLogPath,
  generateToken,
  tryCreateConfigExclusive,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from '../src/server/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const printTokenFixture = join(repoRoot, 'test', 'fixtures', 'print-config-token.ts');

/** Runs the print-config-token fixture in a real child process against `home`. */
function loadConfigInChildProcess(home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [printTokenFixture], {
      cwd: repoRoot,
      env: { ...process.env, TASKSWARM_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`print-config-token exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

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

  it('tryCreateConfigExclusive returns false and never touches the winner’s file when it loses the race', () => {
    const winner = loadOrCreateConfig();

    // A losing exclusive-create attempt (e.g. because another process's
    // file already landed) must report defeat rather than overwriting.
    const won = tryCreateConfigExclusive({
      token: 'a-loser-token-that-must-never-land-on-disk',
      port: 9999,
      host: '0.0.0.0',
      ntfy: { enabled: true },
    });

    expect(won).toBe(false);
    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as { token: string };
    expect(onDisk.token).toBe(winner.token);
  });

  it('tryCreateConfigExclusive returns true and persists the config when no file exists yet', () => {
    expect(existsSync(getConfigPath())).toBe(false);
    const config = {
      token: 'brand-new-token',
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      ntfy: { enabled: false },
    };
    const won = tryCreateConfigExclusive(config);
    expect(won).toBe(true);
    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as { token: string };
    expect(onDisk.token).toBe('brand-new-token');
  });

  it(
    'two processes racing to create the config on first boot agree on the same token ' +
      '(TOCTOU regression: exclusive create + re-read-on-loss)',
    async () => {
      expect(existsSync(getConfigPath())).toBe(false);

      const [tokenA, tokenB] = await Promise.all([
        loadConfigInChildProcess(dir),
        loadConfigInChildProcess(dir),
      ]);

      expect(tokenA).toBeTruthy();
      expect(tokenA).toBe(tokenB);

      // The file on disk must also reflect exactly this token, never a
      // third value from a losing writer that clobbered the winner.
      const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as { token: string };
      expect(onDisk.token).toBe(tokenA);
    },
    20000,
  );
});
