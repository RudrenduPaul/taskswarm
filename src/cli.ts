#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Command, Option } from 'commander';
import { AGENT_STATUSES, AGENT_TYPES } from './schema/events.js';
import { loadOrCreateConfig, rotateToken } from './server/config.js';
import { startServer } from './server/index.js';
import type { RunningServer } from './server/index.js';
import { addTask, listTasks } from './cli/tasks-registry.js';
import type { TaskRecord } from './cli/tasks-registry.js';
import { postEvent, getSessions } from './cli/api-client.js';
import { GenericAdapter } from './adapters/generic-adapter.js';
import { ClaudeCodeAdapter, installClaudeCodeHooks } from './adapters/claude-code-adapter.js';
import type { HookInstallScope } from './adapters/claude-code-adapter.js';

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Reports a command failure and sets a non-zero exit code. Honors the
 * CLI's `--json` contract: when the invocation requested `--json`, the
 * error is printed as parseable `{"error": "<message>"}` on stdout (never
 * stderr, so a caller piping/parsing stdout still gets valid JSON) instead
 * of the plain-text `Error: ...` message.
 */
function fail(message: string, json = false): void {
  if (json) {
    printJson({ error: message });
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Adapts a raw Claude Code hook payload (JSON string) and relays it to the
 * local TaskSwarm server. Split out from the `claude-code-relay` action so
 * it can be exercised directly in tests without faking stdin.
 */
export async function relayClaudeCodeHook(rawPayload: string): Promise<void> {
  const payload = JSON.parse(rawPayload) as Record<string, unknown>;
  const adapter = new ClaudeCodeAdapter();
  const input = adapter.toEventInput(payload);
  const config = loadOrCreateConfig();
  await postEvent(config, input);
}

/**
 * Boots the server and prints the human/JSON startup message. Split out
 * from the `start` action (which additionally wires SIGINT/SIGTERM ->
 * process.exit) so the boot + print logic can be exercised directly in
 * tests without a real process ever exiting.
 */
export async function runStartCommand(json: boolean): Promise<RunningServer> {
  const running = await startServer();
  if (json) {
    printJson({ url: running.url, host: running.config.host, port: running.config.port });
  } else {
    console.log(
      `TaskSwarm server listening on http://${running.config.host}:${running.config.port}`,
    );
    console.log(`Live status page: ${running.url}`);
    console.log('Press Ctrl+C to stop.');
  }
  return running;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('taskswarm')
    .description(
      'Self-hosted, event-driven coordination for parallel coding-agent sessions (Claude Code, Codex, Cursor).',
    )
    .version(PACKAGE_VERSION);

  program
    .command('start')
    .description('Start the TaskSwarm server and print the live status page URL')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const running = await runStartCommand(opts.json ?? false);
        const shutdown = (): void => {
          void running.close().finally(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error) {
        fail(`failed to start server: ${(error as Error).message}`, opts.json ?? false);
      }
    });

  const taskCmd = program.command('task').description('Manage locally tracked tasks');

  taskCmd
    .command('add')
    .description('Register a new task')
    .requiredOption('--title <title>', 'human-readable task title')
    .requiredOption('--repo <path>', 'path to the repository the task operates on')
    .option('--json', 'output machine-readable JSON')
    .action((opts: { title: string; repo: string; json?: boolean }) => {
      const record: TaskRecord = {
        id: randomUUID(),
        title: opts.title,
        repo: opts.repo,
        created_at: new Date().toISOString(),
      };
      try {
        addTask(record);
      } catch (error) {
        fail(`failed to save task: ${(error as Error).message}`, opts.json ?? false);
        return;
      }
      if (opts.json) {
        printJson(record);
      } else {
        console.log(`Task created: ${record.id}`);
        console.log(`  title: ${record.title}`);
        console.log(`  repo:  ${record.repo}`);
      }
    });

  taskCmd
    .command('list')
    .description('List tracked tasks, enriched with live status when the server is reachable')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const tasks = listTasks();
      const statusById = new Map<string, string>();
      try {
        const config = loadOrCreateConfig();
        const sessions = await getSessions(config);
        for (const session of sessions) {
          statusById.set(session.session_id, session.latest.status);
        }
      } catch {
        // Server not running (or unreachable) -- task list still works, just
        // without live status enrichment.
      }
      const rows = tasks.map((task) => ({
        ...task,
        status: statusById.get(task.id) ?? 'unknown',
      }));
      if (opts.json) {
        printJson(rows);
        return;
      }
      if (rows.length === 0) {
        console.log(
          'No tasks yet. Create one with `taskswarm task add --title <t> --repo <path>`.',
        );
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  [${row.status}]  ${row.title}  (${row.repo})`);
      }
    });

  const agentCmd = program.command('agent').description('Report agent session status');

  agentCmd
    .command('report-status')
    .description('Report a status transition for a task/session to the local TaskSwarm server')
    .requiredOption('--task <id>', 'task/session id (the id returned by `task add`)')
    .requiredOption('--repo <path>', 'path to the repository the session operates on')
    .addOption(
      new Option('--state <state>', 'new status')
        .choices([...AGENT_STATUSES])
        .makeOptionMandatory(true),
    )
    .option('--blocked-reason <text>', 'reason, shown when status is blocked/needs-review/failed')
    .addOption(
      new Option('--agent-type <type>', 'reporting agent')
        .choices([...AGENT_TYPES])
        .default('generic'),
    )
    .option('--json', 'output machine-readable JSON')
    .action(
      async (opts: {
        task: string;
        repo: string;
        state: string;
        blockedReason?: string;
        agentType: string;
        json?: boolean;
      }) => {
        const adapter = new GenericAdapter();
        const rawInput: Record<string, unknown> = {
          session_id: opts.task,
          repo: opts.repo,
          status: opts.state,
          agent_type: opts.agentType,
        };
        if (opts.blockedReason) {
          rawInput['blocked_reason'] = opts.blockedReason;
        }
        try {
          const input = adapter.toEventInput(rawInput);
          const config = loadOrCreateConfig();
          const event = await postEvent(config, input);
          if (opts.json) {
            printJson(event);
          } else {
            console.log(`Reported ${event.session_id} -> ${event.status}`);
          }
        } catch (error) {
          fail((error as Error).message, opts.json ?? false);
        }
      },
    );

  const tokenCmd = program.command('token').description('Manage the API bearer token');

  tokenCmd
    .command('rotate')
    .description('Generate a new bearer token, invalidating the old one')
    .option('--json', 'output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      try {
        const newToken = rotateToken();
        if (opts.json) {
          printJson({ token: newToken });
        } else {
          console.log(
            'Bearer token rotated. Update any configured clients/hooks with the new value:',
          );
          console.log(newToken);
        }
      } catch (error) {
        fail(`failed to rotate token: ${(error as Error).message}`, opts.json ?? false);
      }
    });

  const hooksCmd = program.command('hooks').description('Manage agent hook integrations');

  hooksCmd
    .command('install')
    .description('Install TaskSwarm hooks for an agent integration (currently: claude-code)')
    .argument('<adapter>', 'adapter name, e.g. claude-code')
    .addOption(
      new Option('--scope <scope>', 'settings.json scope to write hooks into')
        .choices(['project', 'local', 'user'])
        .default('project'),
    )
    .option('--project-dir <path>', 'project directory (for project/local scope)', process.cwd())
    .option('--json', 'output machine-readable JSON')
    .action(
      (
        adapterName: string,
        opts: { scope: HookInstallScope; projectDir: string; json?: boolean },
      ) => {
        if (adapterName !== 'claude-code') {
          fail(
            `unknown adapter "${adapterName}". Supported adapters: claude-code`,
            opts.json ?? false,
          );
          return;
        }
        try {
          const result = installClaudeCodeHooks({
            scope: opts.scope,
            projectDir: opts.projectDir,
            homeDir: homedir(),
          });
          if (opts.json) {
            printJson(result);
          } else if (result.changed) {
            console.log(`Installed Claude Code Stop/Notification hooks -> ${result.settingsPath}`);
          } else {
            console.log(`Claude Code hooks already installed at ${result.settingsPath}`);
          }
        } catch (error) {
          fail(`failed to install hooks: ${(error as Error).message}`, opts.json ?? false);
        }
      },
    );

  hooksCmd
    .command('claude-code-relay')
    .description(
      'Internal: reads a Claude Code hook payload from stdin and relays it to the local TaskSwarm server. ' +
        'Installed automatically by `taskswarm hooks install claude-code`; not meant to be run by hand.',
    )
    .action(async () => {
      // This command runs inside a Claude Code hook invocation. It must
      // never fail the hook (which could interrupt the coding session), so
      // every error path logs to stderr and still exits 0.
      try {
        const raw = await readStdin();
        await relayClaudeCodeHook(raw);
      } catch (error) {
        process.stderr.write(`taskswarm hook relay: ${(error as Error).message}\n`);
      }
      process.exitCode = 0;
    });

  return program;
}

// process.argv[1] is the invoked path, which npm's global install always symlinks
// (e.g. /opt/homebrew/bin/taskswarm -> .../dist/cli.js). import.meta.url reflects the
// symlink-resolved real path, so it must be compared against a resolved argv[1] too,
// or this guard is always false for every globally-installed npm CLI invocation.
const isMainModule = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
