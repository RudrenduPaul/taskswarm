// Public library surface. Most users will interact with TaskSwarm through
// the CLI (`taskswarm`/`taskswarm-cli`); these exports exist for tooling
// that wants to embed the event store, adapters, or server programmatically.

export {
  agentEventSchema,
  agentEventInputSchema,
  toAgentEvent,
  AGENT_TYPES,
  AGENT_STATUSES,
  NOTIFY_ON_STATUSES,
  CURRENT_SCHEMA_VERSION,
} from './schema/events.js';
export type { AgentEvent, AgentEventInput, AgentType, AgentStatus } from './schema/events.js';

export { EventStore } from './server/event-store.js';
export type { SessionState } from './server/event-store.js';

export { startServer } from './server/index.js';
export type { RunningServer, StartServerOptions } from './server/index.js';

export {
  loadOrCreateConfig,
  saveConfig,
  rotateToken,
  generateToken,
  getTaskSwarmHome,
} from './server/config.js';
export type { TaskSwarmConfig } from './server/config.js';

export { notify, shouldNotify } from './notify/index.js';
export type { NotifyOptions } from './notify/index.js';

export { GenericAdapter } from './adapters/generic-adapter.js';
export { ClaudeCodeAdapter, installClaudeCodeHooks } from './adapters/claude-code-adapter.js';
export type {
  HookInstallScope,
  InstallHooksOptions,
  InstallHooksResult,
} from './adapters/claude-code-adapter.js';
export type { AgentAdapter } from './adapters/types.js';
