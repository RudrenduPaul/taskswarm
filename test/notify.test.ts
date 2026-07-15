import { describe, it, expect, vi } from 'vitest';
import { notify, shouldNotify } from '../src/notify/index.js';
import { sendOsNotification } from '../src/notify/os-notify.js';
import { sendNtfyNotification } from '../src/notify/ntfy.js';
import type { AgentEvent, AgentStatus } from '../src/schema/events.js';

vi.mock('../src/notify/os-notify.js', () => ({ sendOsNotification: vi.fn() }));
vi.mock('../src/notify/ntfy.js', () => ({ sendNtfyNotification: vi.fn() }));

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

  it('fires again on same-status re-entry when blocked_reason differs (e.g. two distinct permission prompts)', () => {
    expect(
      shouldNotify(
        'needs-review',
        'needs-review',
        'approve write to foo.ts',
        'approve write to bar.ts',
      ),
    ).toBe(true);
    expect(shouldNotify('blocked', 'blocked', 'idle nudge #2', 'idle nudge #1')).toBe(true);
  });

  it('fires when blocked_reason newly appears on a same-status re-entry', () => {
    expect(shouldNotify('needs-review', 'needs-review', 'now blocked on X', undefined)).toBe(true);
  });

  it('still dedupes a truly identical consecutive event (same status AND same blocked_reason)', () => {
    expect(
      shouldNotify(
        'needs-review',
        'needs-review',
        'approve write to foo.ts',
        'approve write to foo.ts',
      ),
    ).toBe(false);
    expect(shouldNotify('blocked', 'blocked', undefined, undefined)).toBe(false);
  });
});

describe('notify', () => {
  it('calls the OS notifier on a notify-worthy transition', () => {
    const osNotifier = vi.fn();
    const event = makeEvent('blocked', { blocked_reason: 'waiting on approval' });

    notify(event, 'running', undefined, { osNotifier });

    expect(osNotifier).toHaveBeenCalledTimes(1);
    const [title, message] = osNotifier.mock.calls[0] as [string, string];
    expect(title).toContain('s1');
    expect(title).toContain('blocked');
    expect(message).toContain('waiting on approval');
  });

  it('does not call the OS notifier for a non-notify-worthy transition', () => {
    const osNotifier = vi.fn();
    notify(makeEvent('running'), 'queued', undefined, { osNotifier });
    expect(osNotifier).not.toHaveBeenCalled();
  });

  it('does not call ntfy when disabled (self-hosted-by-default)', () => {
    const osNotifier = vi.fn();
    const ntfySender = vi.fn().mockResolvedValue(undefined);
    notify(makeEvent('failed'), 'running', undefined, {
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
    notify(makeEvent('done'), 'running', undefined, {
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
    notify(makeEvent('done'), 'running', undefined, {
      osNotifier: vi.fn(),
      ntfySender,
      ntfy: { enabled: true },
    });
    expect(ntfySender).not.toHaveBeenCalled();
  });

  it('routes ntfy failures to onNtfyError without throwing', async () => {
    const onNtfyError = vi.fn();
    const ntfySender = vi.fn().mockRejectedValue(new Error('network down'));
    notify(makeEvent('failed'), 'running', undefined, {
      osNotifier: vi.fn(),
      ntfySender,
      ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/x' },
      onNtfyError,
    });
    // ntfySender rejection is handled asynchronously
    await vi.waitFor(() => expect(onNtfyError).toHaveBeenCalledTimes(1));
  });

  it('notifies again on same-status re-entry with a different blocked_reason (two distinct permission prompts)', () => {
    const osNotifier = vi.fn();
    const first = makeEvent('needs-review', { blocked_reason: 'approve write to foo.ts' });
    const second = makeEvent('needs-review', { blocked_reason: 'approve write to bar.ts' });

    notify(first, 'running', undefined, { osNotifier });
    notify(second, first.status, first.blocked_reason, { osNotifier });

    expect(osNotifier).toHaveBeenCalledTimes(2);
    const secondMessage = (osNotifier.mock.calls[1] as [string, string])[1];
    expect(secondMessage).toContain('approve write to bar.ts');
  });

  it('falls back to the real OS notifier when no osNotifier override is provided', () => {
    vi.mocked(sendOsNotification).mockClear();
    notify(makeEvent('done'), 'running', undefined);
    expect(sendOsNotification).toHaveBeenCalledTimes(1);
  });

  it('falls back to the real ntfy sender when no ntfySender override is provided but ntfy is enabled', () => {
    vi.mocked(sendNtfyNotification).mockClear().mockResolvedValue(undefined);
    notify(makeEvent('failed'), 'running', undefined, {
      osNotifier: vi.fn(),
      ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/fallback' },
    });
    expect(sendNtfyNotification).toHaveBeenCalledWith(
      'https://ntfy.sh/fallback',
      expect.any(String),
      expect.any(String),
    );
  });

  it('does not re-notify when both status and blocked_reason are identical to the previous event', () => {
    const osNotifier = vi.fn();
    const first = makeEvent('needs-review', { blocked_reason: 'approve write to foo.ts' });
    const duplicate = makeEvent('needs-review', { blocked_reason: 'approve write to foo.ts' });

    notify(first, 'running', undefined, { osNotifier });
    notify(duplicate, first.status, first.blocked_reason, { osNotifier });

    expect(osNotifier).toHaveBeenCalledTimes(1);
  });
});
