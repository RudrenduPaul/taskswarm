import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericAdapter } from '../src/adapters/generic-adapter.js';
import {
  ClaudeCodeAdapter,
  installClaudeCodeHooks,
  RELAY_COMMAND,
} from '../src/adapters/claude-code-adapter.js';
import { AdapterValidationError } from '../src/adapters/types.js';

describe('GenericAdapter', () => {
  const adapter = new GenericAdapter();

  it('builds a valid event input from a well-formed raw payload', () => {
    const input = adapter.toEventInput({
      session_id: 'task-1',
      repo: '/repo',
      status: 'running',
      agent_type: 'codex',
    });
    expect(input).toEqual({
      session_id: 'task-1',
      repo: '/repo',
      agent_type: 'codex',
      status: 'running',
    });
  });

  it('defaults agent_type to generic when omitted', () => {
    const input = adapter.toEventInput({ session_id: 't', repo: '/r', status: 'done' });
    expect(input.agent_type).toBe('generic');
  });

  it('includes blocked_reason only when provided and non-empty', () => {
    const withReason = adapter.toEventInput({
      session_id: 't',
      repo: '/r',
      status: 'blocked',
      blocked_reason: 'stuck',
    });
    expect(withReason.blocked_reason).toBe('stuck');

    const without = adapter.toEventInput({ session_id: 't', repo: '/r', status: 'blocked' });
    expect(without.blocked_reason).toBeUndefined();
  });

  it('rejects a missing session_id', () => {
    expect(() => adapter.toEventInput({ repo: '/r', status: 'running' })).toThrow(
      AdapterValidationError,
    );
  });

  it('rejects a missing repo', () => {
    expect(() => adapter.toEventInput({ session_id: 't', status: 'running' })).toThrow(
      AdapterValidationError,
    );
  });

  it('rejects an invalid status', () => {
    expect(() => adapter.toEventInput({ session_id: 't', repo: '/r', status: 'napping' })).toThrow(
      AdapterValidationError,
    );
  });

  it('rejects an invalid agent_type', () => {
    expect(() =>
      adapter.toEventInput({ session_id: 't', repo: '/r', status: 'running', agent_type: 'bard' }),
    ).toThrow(AdapterValidationError);
  });
});

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();

  it('maps a Stop hook payload to a done event', () => {
    const input = adapter.toEventInput({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'Stop',
    });
    expect(input).toEqual({
      session_id: 'abc',
      repo: '/repo',
      agent_type: 'claude-code',
      status: 'done',
    });
  });

  it('maps a permission_prompt Notification to needs-review', () => {
    const input = adapter.toEventInput({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    });
    expect(input.status).toBe('needs-review');
    expect(input.blocked_reason).toMatch(/permission/i);
  });

  it('maps an idle_prompt Notification to blocked', () => {
    const input = adapter.toEventInput({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    expect(input.status).toBe('blocked');
  });

  it('maps an unrecognized Notification type to needs-review without dropping it', () => {
    const input = adapter.toEventInput({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'Notification',
      notification_type: 'elicitation_dialog',
    });
    expect(input.status).toBe('needs-review');
    expect(input.blocked_reason).toContain('elicitation_dialog');
  });

  it('rejects an unsupported hook_event_name', () => {
    expect(() =>
      adapter.toEventInput({ session_id: 'abc', cwd: '/repo', hook_event_name: 'PreToolUse' }),
    ).toThrow(AdapterValidationError);
  });

  it('rejects a payload missing session_id', () => {
    expect(() => adapter.toEventInput({ cwd: '/repo', hook_event_name: 'Stop' })).toThrow(
      AdapterValidationError,
    );
  });

  it('rejects a payload missing cwd', () => {
    expect(() => adapter.toEventInput({ session_id: 'abc', hook_event_name: 'Stop' })).toThrow(
      AdapterValidationError,
    );
  });
});

describe('installClaudeCodeHooks', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'taskswarm-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'taskswarm-home-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.json with Stop and Notification hooks (project scope)', () => {
    const result = installClaudeCodeHooks({ scope: 'project', projectDir, homeDir });
    expect(result.changed).toBe(true);
    expect(result.settingsPath).toBe(join(projectDir, '.claude', 'settings.json'));

    const written = JSON.parse(readFileSync(result.settingsPath, 'utf-8'));
    expect(written.hooks.Stop[0].hooks[0].command).toBe(RELAY_COMMAND);
    expect(written.hooks.Notification[0].hooks[0].command).toBe(RELAY_COMMAND);
  });

  it('is idempotent: running it twice does not duplicate hook entries', () => {
    installClaudeCodeHooks({ scope: 'project', projectDir, homeDir });
    const second = installClaudeCodeHooks({ scope: 'project', projectDir, homeDir });
    expect(second.changed).toBe(false);

    const written = JSON.parse(readFileSync(second.settingsPath, 'utf-8'));
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it('preserves existing unrelated settings.json content', () => {
    const claudeDir = join(projectDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }),
    );

    const result = installClaudeCodeHooks({ scope: 'project', projectDir, homeDir });
    const written = JSON.parse(readFileSync(result.settingsPath, 'utf-8'));
    expect(written.permissions.allow).toEqual(['Bash(ls)']);
    expect(written.hooks.Stop[0].hooks[0].command).toBe(RELAY_COMMAND);
  });

  it('writes to settings.local.json for local scope', () => {
    const result = installClaudeCodeHooks({ scope: 'local', projectDir, homeDir });
    expect(result.settingsPath).toBe(join(projectDir, '.claude', 'settings.local.json'));
  });

  it('writes to the home directory for user scope', () => {
    const result = installClaudeCodeHooks({ scope: 'user', projectDir, homeDir });
    expect(result.settingsPath).toBe(join(homeDir, '.claude', 'settings.json'));
  });
});
