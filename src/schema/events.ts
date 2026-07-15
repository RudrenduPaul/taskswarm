import { z } from 'zod';

/**
 * The current envelope version. Bump this whenever the shape of AgentEvent
 * changes in a way that is not purely additive-and-optional. Consumers can
 * branch on `schema_version` to stay forward compatible.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Agent integrations TaskSwarm ships an adapter for in v0.1. */
export const AGENT_TYPES = ['claude-code', 'codex', 'cursor', 'generic'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Lifecycle states a tracked session can be in. TaskSwarm's notification
 * layer fires on a transition into 'blocked' | 'needs-review' | 'failed' | 'done' --
 * the four states that mean "a human should look at this now."
 */
export const AGENT_STATUSES = [
  'queued',
  'running',
  'blocked',
  'needs-review',
  'done',
  'failed',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The subset of statuses that should trigger a notification on transition. */
export const NOTIFY_ON_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'blocked',
  'needs-review',
  'failed',
  'done',
]);

/**
 * Generic, versioned event envelope every agent adapter (and the generic
 * CLI wrapper path) emits. Deliberately minimal: no signatures, no
 * tamper-evidence hashing, no actor identity beyond session_id. Those are
 * an explicitly deferred, out-of-scope-for-v0.1 concern.
 */
export const agentEventSchema = z.object({
  event_id: z.string().uuid(),
  session_id: z.string().min(1).max(256),
  repo: z.string().min(1).max(1024),
  agent_type: z.enum(AGENT_TYPES),
  status: z.enum(AGENT_STATUSES),
  blocked_reason: z.string().max(4096).optional(),
  timestamp: z.string().datetime({ offset: true }),
  schema_version: z.number().int().positive(),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * Input accepted from CLI/adapters before event_id/timestamp/schema_version
 * are stamped on. Keeps callers from having to generate boilerplate.
 */
export const agentEventInputSchema = agentEventSchema
  .omit({ event_id: true, timestamp: true, schema_version: true })
  .extend({
    event_id: z.string().uuid().optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    schema_version: z.number().int().positive().optional(),
  });

export type AgentEventInput = z.infer<typeof agentEventInputSchema>;

/** Fills in event_id/timestamp/schema_version defaults for a partial input. */
export function toAgentEvent(input: AgentEventInput): AgentEvent {
  return {
    ...input,
    event_id: input.event_id ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    schema_version: input.schema_version ?? CURRENT_SCHEMA_VERSION,
  };
}
