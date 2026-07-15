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

/**
 * A stable substring every relay command contains, used to find and replace
 * a previously installed relay hook (e.g. after an upgrade moves the CLI's
 * install path) without leaving stale or duplicate entries behind.
 */
const RELAY_MARKER = 'hooks claude-code-relay';

/**
 * Builds the exact command Claude Code should run for the Stop/Notification
 * hooks: the currently-running Node executable invoking the currently-
 * installed CLI script directly, both as absolute, quoted paths.
 *
 * Deliberately NOT `npx --yes taskswarm-cli ...`: that form re-resolves
 * against the npm registry on every single hook fire (Stop fires on every
 * Claude Code turn), with no version pin and no confirmation prompt. Before
 * the package is even published, that is an open name-squatting window --
 * whoever publishes `taskswarm-cli` first controls what runs. After
 * publish, it's a standing supply-chain risk: any compromised maintainer
 * token or bad release propagates to every installed user automatically.
 * Invoking the exact binary the user already has on disk means the hook
 * only ever runs code that was already trusted at install time.
 */
export function buildRelayCommand(nodeExecPath: string, cliScriptPath: string): string {
  return `${quoteShellArg(nodeExecPath)} ${quoteShellArg(cliScriptPath)} hooks claude-code-relay`;
}

function quoteShellArg(value: string): string {
  // POSIX-safe single-quote escaping: close the quote, emit an escaped
  // literal quote, reopen the quote. Handles spaces and any shell
  // metacharacters in the path (e.g. install dirs with spaces).
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (error) {
    throw new AdapterValidationError(
      `${path} is not valid JSON, so TaskSwarm can't safely merge hooks into it. ` +
        `Fix or remove the file, then re-run hooks install. (${(error as Error).message})`,
    );
  }
}

/** Finds an existing relay hook entry (by its stable marker), if any. */
function findRelayHookCommand(groups: HookGroup[] | undefined): string | undefined {
  if (!groups) return undefined;
  for (const group of groups) {
    const hook = group.hooks.find((h) => h.command.includes(RELAY_MARKER));
    if (hook) return hook.command;
  }
  return undefined;
}

/**
 * Installs or repoints the relay hook for one event. Idempotent when the
 * resolved command hasn't changed; self-healing (replaces the stale entry
 * rather than adding a duplicate) when it has, e.g. after the CLI's install
 * path moved between an upgrade.
 */
function addRelayHook(
  settings: ClaudeSettings,
  event: 'Stop' | 'Notification',
  relayCommand: string,
): boolean {
  settings.hooks ??= {};
  const existing = settings.hooks[event];
  const currentCommand = findRelayHookCommand(existing);
  if (currentCommand === relayCommand) {
    return false;
  }

  const groupsWithoutStaleRelay = (existing ?? [])
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !hook.command.includes(RELAY_MARKER)),
    }))
    .filter((group) => group.hooks.length > 0);

  const newGroup: HookGroup = {
    matcher: '',
    hooks: [{ type: 'command', command: relayCommand, timeout: 10 }],
  };
  settings.hooks[event] = [...groupsWithoutStaleRelay, newGroup];
  return true;
}

export interface InstallHooksOptions {
  scope: HookInstallScope;
  projectDir: string;
  homeDir: string;
  /** The Node executable to invoke. Defaults to `process.execPath`. */
  nodeExecPath?: string;
  /** The absolute path to the currently-installed CLI script. Defaults to `process.argv[1]`. */
  cliScriptPath?: string;
}

export interface InstallHooksResult {
  settingsPath: string;
  changed: boolean;
}

/**
 * Writes (merging with any existing content) Stop and Notification hook
 * entries into the appropriate Claude Code settings.json, pointing at
 * TaskSwarm's relay command -- resolved to the exact Node binary and CLI
 * script already installed on this machine, never a floating registry
 * reference. Idempotent: running it again when the hooks are already
 * installed and pointing at the same resolved path is a no-op
 * (changed: false); repoints (without duplicating) if the resolved path
 * has changed since the last install.
 */
export function installClaudeCodeHooks(options: InstallHooksOptions): InstallHooksResult {
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const cliScriptPath = options.cliScriptPath ?? process.argv[1];
  if (!cliScriptPath) {
    throw new AdapterValidationError(
      'could not resolve the running CLI script path to install a hook against',
    );
  }
  const relayCommand = buildRelayCommand(nodeExecPath, cliScriptPath);

  const settingsPath = settingsPathForScope(options.scope, options.projectDir, options.homeDir);
  const settings = readSettings(settingsPath);

  const stopChanged = addRelayHook(settings, 'Stop', relayCommand);
  const notificationChanged = addRelayHook(settings, 'Notification', relayCommand);
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
