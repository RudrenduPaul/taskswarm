import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram, runStartCommand, relayClaudeCodeHook } from '../src/cli.js';
import { startServer } from '../src/server/index.js';
import type { RunningServer } from '../src/server/index.js';

async function run(args: string[]): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    errors.push(String(msg));
  });
  try {
    await buildProgram().parseAsync(['node', 'taskswarm', ...args]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { logs, errors };
}

describe('CLI commands', () => {
  let home: string;
  const originalHome = process.env['TASKSWARM_HOME'];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'taskswarm-cli-home-'));
    process.env['TASKSWARM_HOME'] = home;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['TASKSWARM_HOME'];
    } else {
      process.env['TASKSWARM_HOME'] = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  describe('task add / task list', () => {
    it('creates a task and prints JSON with --json', async () => {
      const { logs } = await run([
        'task',
        'add',
        '--title',
        'Fix flaky test',
        '--repo',
        '/repo/a',
        '--json',
      ]);
      expect(process.exitCode).toBeUndefined();
      const record = JSON.parse(logs.join('\n')) as { id: string; title: string; repo: string };
      expect(record.title).toBe('Fix flaky test');
      expect(record.repo).toBe('/repo/a');
      expect(record.id).toBeTruthy();
    });

    it('prints a human-readable confirmation without --json', async () => {
      const { logs } = await run(['task', 'add', '--title', 'Ship feature', '--repo', '/repo/b']);
      expect(logs.join('\n')).toContain('Task created');
      expect(logs.join('\n')).toContain('Ship feature');
    });

    it('lists tasks created earlier, with status "unknown" when the server is not running', async () => {
      await run(['task', 'add', '--title', 'T1', '--repo', '/repo/a', '--json']);
      const { logs } = await run(['task', 'list', '--json']);
      const rows = JSON.parse(logs.join('\n')) as Array<{ title: string; status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('T1');
      expect(rows[0]?.status).toBe('unknown');
    });

    it('reports no tasks in human mode when none exist', async () => {
      const { logs } = await run(['task', 'list']);
      expect(logs.join('\n')).toContain('No tasks yet');
    });
  });

  describe('token rotate', () => {
    it('rotates the token and persists it to config.json', async () => {
      const configPath = join(home, 'config.json');
      const { logs } = await run(['token', 'rotate', '--json']);
      expect(existsSync(configPath)).toBe(true);
      const { token } = JSON.parse(logs.join('\n')) as { token: string };
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as { token: string };
      expect(persisted.token).toBe(token);
    });
  });

  describe('hooks install claude-code', () => {
    it('writes hook config into the target project directory', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'taskswarm-project-'));
      try {
        const { logs } = await run([
          'hooks',
          'install',
          'claude-code',
          '--project-dir',
          projectDir,
          '--json',
        ]);
        const result = JSON.parse(logs.join('\n')) as { settingsPath: string; changed: boolean };
        expect(result.changed).toBe(true);
        expect(existsSync(result.settingsPath)).toBe(true);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('rejects an unknown adapter name with a non-zero exit code', async () => {
      const { errors } = await run(['hooks', 'install', 'codex']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('unknown adapter');
    });
  });

  describe('agent report-status', () => {
    let running: RunningServer;

    beforeEach(async () => {
      running = await startServer({ logPath: null, notifyOptions: { osNotifier: () => {} } });
    });

    afterEach(async () => {
      await running.close();
    });

    it('reports status to a running server and prints the stored event', async () => {
      const { logs } = await run([
        'agent',
        'report-status',
        '--task',
        'task-1',
        '--repo',
        '/repo/a',
        '--state',
        'blocked',
        '--blocked-reason',
        'waiting on CI',
        '--json',
      ]);
      expect(process.exitCode).toBeUndefined();
      const event = JSON.parse(logs.join('\n')) as { status: string; blocked_reason: string };
      expect(event.status).toBe('blocked');
      expect(event.blocked_reason).toBe('waiting on CI');
      expect(running.store.getSession('task-1')?.latest.status).toBe('blocked');
    });

    it('enriches task list with live status once reported', async () => {
      await run(['task', 'add', '--title', 'Live task', '--repo', '/repo/a', '--json']);
      const tasks = JSON.parse((await run(['task', 'list', '--json'])).logs.join('\n')) as Array<{
        id: string;
      }>;
      const taskId = tasks[0]!.id;

      await run([
        'agent',
        'report-status',
        '--task',
        taskId,
        '--repo',
        '/repo/a',
        '--state',
        'running',
        '--json',
      ]);

      const { logs } = await run(['task', 'list', '--json']);
      const rows = JSON.parse(logs.join('\n')) as Array<{ id: string; status: string }>;
      expect(rows.find((r) => r.id === taskId)?.status).toBe('running');
    });
  });

  describe('agent report-status without a running server', () => {
    it('fails with a non-zero exit code and a clear error message', async () => {
      const { errors } = await run([
        'agent',
        'report-status',
        '--task',
        'task-x',
        '--repo',
        '/repo/a',
        '--state',
        'running',
      ]);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/could not reach|server/i);
    });
  });

  describe('runStartCommand', () => {
    it('boots a server and prints JSON output when requested', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let running: RunningServer | undefined;
      try {
        running = await runStartCommand(true);
        expect(running.server.listening).toBe(true);
        const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        const parsed = JSON.parse(printed) as { url: string; host: string; port: number };
        expect(parsed.url).toContain(running.config.token);
        expect(parsed.host).toBe(running.config.host);
      } finally {
        logSpy.mockRestore();
        await running?.close();
      }
    });

    it('boots a server and prints a human-readable message by default', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let running: RunningServer | undefined;
      try {
        running = await runStartCommand(false);
        const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(printed).toContain('TaskSwarm server listening');
        expect(printed).toContain('Live status page');
      } finally {
        logSpy.mockRestore();
        await running?.close();
      }
    });
  });

  describe('relayClaudeCodeHook', () => {
    let running: RunningServer;

    beforeEach(async () => {
      running = await startServer({ logPath: null, notifyOptions: { osNotifier: () => {} } });
    });

    afterEach(async () => {
      await running.close();
    });

    it('adapts a Stop hook payload and posts it to the running server', async () => {
      await relayClaudeCodeHook(
        JSON.stringify({ session_id: 'cc-session', cwd: '/repo/x', hook_event_name: 'Stop' }),
      );
      expect(running.store.getSession('cc-session')?.latest.status).toBe('done');
    });

    it('adapts a Notification payload with a permission_prompt type', async () => {
      await relayClaudeCodeHook(
        JSON.stringify({
          session_id: 'cc-session-2',
          cwd: '/repo/x',
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
        }),
      );
      expect(running.store.getSession('cc-session-2')?.latest.status).toBe('needs-review');
    });

    it('rejects malformed JSON', async () => {
      await expect(relayClaudeCodeHook('not json')).rejects.toThrow();
    });

    it('rejects a payload with an unsupported hook_event_name', async () => {
      await expect(
        relayClaudeCodeHook(
          JSON.stringify({ session_id: 's', cwd: '/repo', hook_event_name: 'PreToolUse' }),
        ),
      ).rejects.toThrow();
    });
  });
});
