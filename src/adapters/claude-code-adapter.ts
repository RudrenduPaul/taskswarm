import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEventInput, AgentType } from '../schema/events.js';
import type { AgentAdapter } from './types.js';
import { AdapterValidationError } from './types.js';

/**
 * Integration with Claude Code's real hooks system.
 *
 * VERIFIED against Claude Code's published hooks reference
 * (https://code.claude.com/docs/en/hooks.md and hooks-guide.md) as of this
 * writing:
 *   - Hooks are configured under a top-level "hooks" key in settings.json,
 *     scoped by file location: project (.claude/settings.json), local
 *     (.claude/settings.local.json, gitignored), or user (~/.claude/settings.json).
 *   - Each event maps to an array of { matcher, hooks: [{ type, command, timeout }] }
 *     groups. matcher: "" (or omitted) matches every occurrence of the event.
 *   - The "Stop" event fires when Claude Code finishes responding to a turn.
 *     Its hook receives a JSON payload on stdin with at least: session_id,
 *     transcript_path, cwd, hook_event_name.
 *   - The "Notification" event fires when Claude Code surfaces a
 *     notification to the user (permission prompts, idle waits, etc). Its
 *     hook receives session_id, cwd, hook_event_name, and notification_type.
 *   - Exit code 0 from a hook command is treated as "no objection"; this
 *     adapter's relay always exits 0 (it only reports status, it never
 *     wants to block Claude Code from stopping).
 *
 * BEST-EFFORT / NOT independently verified against a live Claude Code
 * install in this codebase:
 *   - The exhaustive set of notification_type values beyond
 *     "permission_prompt" and "idle_prompt" (docs mention more; only these
 *     two are mapped explicitly below, everything else falls through to a
 *     generic "needs-review" so nothing is silently dropped).
 *   - "Stop" firing semantics are per-turn, not per-task -- so mapping Stop
 *     directly to TaskSwarm's 'done' status is a v0.1 approximation. A
 *     long multi-turn session will report 'done' after every turn, not just
 *     the final one. This is called out here rather than silently assumed
 *     correct; a future version could debounce or require an explicit
 *     "SessionEnd" signal instead.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentType: AgentType = 'claude-code';
  readonly name = 'Claude Code hooks adapter';

  toEventInput(raw: Record<string, unknown>): AgentEventInput {
    const sessionId = raw['session_id'];
    const cwd = raw['cwd'];
    const hookEventName = raw['hook_event_name'];

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterValidationError('session_id is required in the hook payload');
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new AdapterValidationError('cwd is required in the hook payload');
    }
    if (typeof hookEventName !== 'string') {
      throw new AdapterValidationError('hook_event_name is required in the hook payload');
    }

    const base = { session_id: sessionId, repo: cwd, agent_type: this.agentType };

    if (hookEventName === 'Stop') {
      return { ...base, status: 'done' };
    }

    if (hookEventName === 'Notification') {
      const notificationType = raw['notification_type'];
      if (notificationType === 'permission_prompt') {
        return {
          ...base,
          status: 'needs-review',
          blocked_reason: 'Claude Code is waiting for permission approval',
        };
      }
      if (notificationType === 'idle_prompt') {
        return {
          ...base,
          status: 'blocked',
          blocked_reason: 'Claude Code session is idle, waiting for the next prompt',
        };
      }
      return {
        ...base,
        status: 'needs-review',
        blocked_reason:
          typeof notificationType === 'string'
            ? `Notification: ${notificationType}`
            : 'Claude Code sent a notification',
      };
    }

    throw new AdapterValidationError(
      `unsupported hook_event_name: ${hookEventName} (this adapter handles Stop and Notification)`,
    );
  }
}

export type HookInstallScope = 'project' | 'local' | 'user';

interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** The relay command TaskSwarm installs into Claude Code's Stop/Notification hooks. */
export const RELAY_COMMAND = 'npx --yes taskswarm-cli hooks claude-code-relay';

function settingsPathForScope(
  scope: HookInstallScope,
  projectDir: string,
  homeDir: string,
): string {
  switch (scope) {
    case 'project':
      return join(projectDir, '.claude', 'settings.json');
    case 'local':
      return join(projectDir, '.claude', 'settings.local.json');
    case 'user':
      return join(homeDir, '.claude', 'settings.json');
  }
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf-8').trim();
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw) as ClaudeSettings;
}

function hasRelayHook(groups: HookGroup[] | undefined): boolean {
  if (!groups) return false;
  return groups.some((group) => group.hooks.some((hook) => hook.command === RELAY_COMMAND));
}

function addRelayHook(settings: ClaudeSettings, event: 'Stop' | 'Notification'): boolean {
  settings.hooks ??= {};
  const existing = settings.hooks[event];
  if (hasRelayHook(existing)) {
    return false;
  }
  const group: HookGroup = {
    matcher: '',
    hooks: [{ type: 'command', command: RELAY_COMMAND, timeout: 10 }],
  };
  settings.hooks[event] = [...(existing ?? []), group];
  return true;
}

export interface InstallHooksOptions {
  scope: HookInstallScope;
  projectDir: string;
  homeDir: string;
}

export interface InstallHooksResult {
  settingsPath: string;
  changed: boolean;
}

/**
 * Writes (merging with any existing content) Stop and Notification hook
 * entries into the appropriate Claude Code settings.json, pointing at
 * TaskSwarm's relay command. Idempotent: running it again when the hooks
 * are already installed is a no-op (changed: false).
 */
export function installClaudeCodeHooks(options: InstallHooksOptions): InstallHooksResult {
  const settingsPath = settingsPathForScope(options.scope, options.projectDir, options.homeDir);
  const settings = readSettings(settingsPath);

  const stopChanged = addRelayHook(settings, 'Stop');
  const notificationChanged = addRelayHook(settings, 'Notification');
  const changed = stopChanged || notificationChanged;

  if (changed) {
    const dir = dirname(settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return { settingsPath, changed };
}
