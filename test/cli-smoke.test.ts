import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, [join(repoRoot, 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('failed to allocate a free port')));
      }
    });
    server.on('error', reject);
  });
}

describe('CLI smoke tests (real child process, real exit codes)', () => {
  it('--help exits 0 and prints usage for every top-level command', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('task');
    expect(result.stdout).toContain('agent');
    expect(result.stdout).toContain('token');
    expect(result.stdout).toContain('hooks');
  });

  it('--version exits 0 and prints a version string', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs correctly when invoked through a symlink, like npm global installs do', () => {
    // `npm install -g` always creates a symlink (e.g. /opt/homebrew/bin/taskswarm ->
    // .../dist/cli.js). Node resolves `import.meta.url` to the symlink-resolved real path,
    // but process.argv[1] is the symlink path itself, unless it's realpath'd first. A prior
    // release shipped an isMainModule guard that compared the two directly, so it was always
    // false through a symlink and every command silently no-op'd for every real npm install.
    const home = mkdtempSync(join(tmpdir(), 'taskswarm-smoke-symlink-'));
    const symlinkPath = join(home, 'taskswarm-via-symlink');
    try {
      symlinkSync(join(repoRoot, 'src', 'cli.ts'), symlinkPath);
      const result = spawnSync(tsxBin, [symlinkPath, '--help'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage:');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an invalid --state choice exits non-zero with a clear error', () => {
    const home = mkdtempSync(join(tmpdir(), 'taskswarm-smoke-home-'));
    try {
      const result = runCli(
        ['agent', 'report-status', '--task', 't', '--repo', '/r', '--state', 'napping'],
        { TASKSWARM_HOME: home },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/napping/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a missing required option exits non-zero', () => {
    const result = runCli(['task', 'add', '--title', 'no repo given']);
    expect(result.status).not.toBe(0);
  });

  it('an unknown command exits non-zero', () => {
    const result = runCli(['not-a-real-command']);
    expect(result.status).not.toBe(0);
  });

  it('`start` boots a working server and shuts down cleanly on SIGTERM', async () => {
    const home = mkdtempSync(join(tmpdir(), 'taskswarm-smoke-start-'));
    try {
      const port = await findFreePort();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          token: 'smoke-test-token',
          port,
          host: '127.0.0.1',
          ntfy: { enabled: false },
        }),
      );

      const child = spawn(tsxBin, [join(repoRoot, 'src', 'cli.ts'), 'start'], {
        cwd: repoRoot,
        env: { ...process.env, TASKSWARM_HOME: home },
      });

      let stdout = '';
      const bootDeadline = Date.now() + 10000;
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('Live status page')) resolve();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!stdout.includes('Live status page')) {
            reject(new Error(`process exited early with code ${code}, stdout: ${stdout}`));
          }
        });
        const poll = setInterval(() => {
          if (Date.now() > bootDeadline) {
            clearInterval(poll);
            reject(new Error(`timed out waiting for server to boot, stdout so far: ${stdout}`));
          }
        }, 100);
      });

      // Confirm the live status page is actually reachable over HTTP.
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
