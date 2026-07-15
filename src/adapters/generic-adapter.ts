import type { AgentEventInput, AgentStatus, AgentType } from '../schema/events.js';
import { AGENT_STATUSES, AGENT_TYPES } from '../schema/events.js';
import type { AgentAdapter } from './types.js';
import { AdapterValidationError } from './types.js';

/**
 * The wrapper-script fallback any agent (Codex, Cursor, or anything else
 * without a dedicated adapter) can use. This is the real, always-works
 * integration path in v0.1: a wrapper script around any coding-agent CLI
 * calls `taskswarm agent report-status --task <id> --repo <path> --state
 * <status>` at the points it cares about, which flows through this adapter.
 */
export class GenericAdapter implements AgentAdapter {
  readonly agentType: AgentType = 'generic';
  readonly name = 'Generic wrapper-script adapter';

  toEventInput(raw: Record<string, unknown>): AgentEventInput {
    const sessionId = raw['session_id'];
    const repo = raw['repo'];
    const status = raw['status'];
    const blockedReason = raw['blocked_reason'];
    const agentTypeRaw = raw['agent_type'] ?? 'generic';

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AdapterValidationError('session_id is required');
    }
    if (typeof repo !== 'string' || repo.length === 0) {
      throw new AdapterValidationError('repo is required');
    }
    if (typeof status !== 'string' || !AGENT_STATUSES.includes(status as AgentStatus)) {
      throw new AdapterValidationError(`status must be one of: ${AGENT_STATUSES.join(', ')}`);
    }
    if (typeof agentTypeRaw !== 'string' || !AGENT_TYPES.includes(agentTypeRaw as AgentType)) {
      throw new AdapterValidationError(`agent_type must be one of: ${AGENT_TYPES.join(', ')}`);
    }

    const input: AgentEventInput = {
      session_id: sessionId,
      repo,
      agent_type: agentTypeRaw as AgentType,
      status: status as AgentStatus,
    };
    if (typeof blockedReason === 'string' && blockedReason.length > 0) {
      input.blocked_reason = blockedReason;
    }
    return input;
  }
}
