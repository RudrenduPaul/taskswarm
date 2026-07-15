import type { AgentEventInput, AgentType } from '../schema/events.js';

/**
 * Plugin point every agent integration implements. An adapter's only job is
 * to normalize whatever raw, agent-specific payload it receives (a CLI flag
 * bag, a hook's stdin JSON, ...) into a schema-valid AgentEventInput. Ship
 * new integrations (Codex, Cursor, ...) by adding a new adapter here rather
 * than branching inside the server or CLI.
 */
export interface AgentAdapter {
  readonly agentType: AgentType;
  readonly name: string;
  /** Normalizes adapter-specific raw input into a schema-valid event input. */
  toEventInput(raw: Record<string, unknown>): AgentEventInput;
}

export class AdapterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterValidationError';
  }
}
