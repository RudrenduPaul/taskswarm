import { describe, it, expect, vi } from 'vitest';
import { notify, shouldNotify } from '../src/notify/index.js';
import type { AgentEvent, AgentStatus } from '../src/schema/events.js';

function makeEvent(status: AgentStatus, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: 's1',
    repo: '/repo',
    agent_type: 'generic',
    status,
    timestamp: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  };
}

describe('shouldNotify', () => {
  const notifyWorthy: AgentStatus[] = ['blocked', 'needs-review', 'failed', 'done'];
  const silentStatuses: AgentStatus[] = ['queued', 'running'];

  it.each(notifyWorthy)('fires on a fresh transition into "%s"', (status) => {
    expect(shouldNotify(status, 'running')).toBe(true);
    expect(shouldNotify(status, undefined)).toBe(true);
  });

  it.each(silentStatuses)('never fires for "%s", regardless of previous status', (status) => {
    expect(shouldNotify(status, 'queued')).toBe(false);
    expect(shouldNotify(status, 'blocked')).toBe(false);
    expect(shouldNotify(status, undefined)).toBe(false);
  });

  it.each(notifyWorthy)(
    'does not re-fire when the status repeats itself ("%s" -> same)',
    (status) => {
      expect(shouldNotify(status, status)).toBe(false);
    },
  );

  it('fires again when moving between two different notify-worthy statuses', () => {
    expect(shouldNotify('failed', 'blocked')).toBe(true);
    expect(shouldNotify('done', 'needs-review')).toBe(true);
  });
});

describe('notify', () => {
  it('calls the OS notifier on a notify-worthy transition', () => {
    const osNotifier = vi.fn();
    const event = makeEvent('blocked', { blocked_reason: 'waiting on approval' });

    notify(event, 'running', { osNotifier });

    expect(osNotifier).toHaveBeenCalledTimes(1);
    const [title, message] = osNotifier.mock.calls[0] as [string, string];
    expect(title).toContain('s1');
    expect(title).toContain('blocked');
    expect(message).toContain('waiting on approval');
  });

  it('does not call the OS notifier for a non-notify-worthy transition', () => {
    const osNotifier = vi.fn();
    notify(makeEvent('running'), 'queued', { osNotifier });
    expect(osNotifier).not.toHaveBeenCalled();
  });

  it('does not call ntfy when disabled (self-hosted-by-default)', () => {
    const osNotifier = vi.fn();
    const ntfySender = vi.fn().mockResolvedValue(undefined);
    notify(makeEvent('failed'), 'running', {
      osNotifier,
      ntfySender,
      ntfy: { enabled: false },
    });
    expect(osNotifier).toHaveBeenCalledTimes(1);
    expect(ntfySender).not.toHaveBeenCalled();
  });

  it('calls ntfy only when explicitly enabled with a topic URL', () => {
    const osNotifier = vi.fn();
    const ntfySender = vi.fn().mockResolvedValue(undefined);
    notify(makeEvent('done'), 'running', {
      osNotifier,
      ntfySender,
      ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/my-topic' },
    });
    expect(ntfySender).toHaveBeenCalledWith(
      'https://ntfy.sh/my-topic',
      expect.stringContaining('done'),
      expect.any(String),
    );
  });

  it('does not call ntfy when enabled but missing a topic URL', () => {
    const ntfySender = vi.fn();
    notify(makeEvent('done'), 'running', {
      osNotifier: vi.fn(),
      ntfySender,
      ntfy: { enabled: true },
    });
    expect(ntfySender).not.toHaveBeenCalled();
  });

  it('routes ntfy failures to onNtfyError without throwing', async () => {
    const onNtfyError = vi.fn();
    const ntfySender = vi.fn().mockRejectedValue(new Error('network down'));
    notify(makeEvent('failed'), 'running', {
      osNotifier: vi.fn(),
      ntfySender,
      ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/x' },
      onNtfyError,
    });
    // ntfySender rejection is handled asynchronously
    await vi.waitFor(() => expect(onNtfyError).toHaveBeenCalledTimes(1));
  });
});
