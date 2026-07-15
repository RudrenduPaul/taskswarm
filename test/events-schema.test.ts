import { describe, it, expect } from 'vitest';
import {
  agentEventSchema,
  agentEventInputSchema,
  toAgentEvent,
  CURRENT_SCHEMA_VERSION,
} from '../src/schema/events.js';

describe('agentEventSchema', () => {
  it('accepts a fully valid event', () => {
    const result = agentEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      session_id: 's1',
      repo: '/repo',
      agent_type: 'claude-code',
      status: 'running',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid agent_type', () => {
    const result = agentEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      session_id: 's1',
      repo: '/repo',
      agent_type: 'chatgpt',
      status: 'running',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status', () => {
    const result = agentEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      session_id: 's1',
      repo: '/repo',
      agent_type: 'generic',
      status: 'sleeping',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing session_id', () => {
    const result = agentEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      repo: '/repo',
      agent_type: 'generic',
      status: 'running',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid event_id', () => {
    const result = agentEventSchema.safeParse({
      event_id: 'not-a-uuid',
      session_id: 's1',
      repo: '/repo',
      agent_type: 'generic',
      status: 'running',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional blocked_reason', () => {
    const result = agentEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      session_id: 's1',
      repo: '/repo',
      agent_type: 'generic',
      status: 'blocked',
      blocked_reason: 'waiting on human input',
      timestamp: new Date().toISOString(),
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });
});

describe('agentEventInputSchema / toAgentEvent', () => {
  it('accepts input without event_id/timestamp/schema_version and fills defaults', () => {
    const parsed = agentEventInputSchema.parse({
      session_id: 's1',
      repo: '/repo',
      agent_type: 'generic',
      status: 'queued',
    });
    const event = toAgentEvent(parsed);
    expect(event.event_id).toBeTruthy();
    expect(event.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
    expect(agentEventSchema.safeParse(event).success).toBe(true);
  });

  it('preserves an explicitly provided event_id/timestamp/schema_version', () => {
    const eventId = crypto.randomUUID();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const parsed = agentEventInputSchema.parse({
      event_id: eventId,
      session_id: 's1',
      repo: '/repo',
      agent_type: 'generic',
      status: 'queued',
      timestamp,
      schema_version: 1,
    });
    const event = toAgentEvent(parsed);
    expect(event.event_id).toBe(eventId);
    expect(event.timestamp).toBe(timestamp);
  });
});
