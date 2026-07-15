import type { AgentEvent, AgentStatus } from '../schema/events.js';
import { NOTIFY_ON_STATUSES } from '../schema/events.js';
import { sendOsNotification } from './os-notify.js';
import { sendNtfyNotification } from './ntfy.js';

export interface NotifyOptions {
  ntfy?: {
    enabled: boolean;
    topicUrl?: string;
  };
  /** Injectable for tests; defaults to the real OS notifier. */
  osNotifier?: (title: string, message: string) => void;
  /** Injectable for tests; defaults to the real ntfy.sh sender. */
  ntfySender?: (topicUrl: string, title: string, message: string) => Promise<void>;
  /** Called whenever the ntfy channel throws, so failures never crash the server. */
  onNtfyError?: (error: unknown) => void;
}

/**
 * True if a transition from `previousStatus`/`previousBlockedReason` to
 * `status`/`blockedReason` should notify.
 *
 * Dedup keys on the (status, blocked_reason) pair, not status alone: two
 * different permission prompts in a row are both 'needs-review', and two
 * distinct idle nudges in a row are both 'blocked', but each carries a
 * different (or newly-present) blocked_reason and is a genuinely new event
 * a human should see -- not a duplicate to swallow. Only a same-status
 * event whose blocked_reason also didn't change is treated as a repeat.
 */
export function shouldNotify(
  status: AgentStatus,
  previousStatus: AgentStatus | undefined,
  blockedReason?: string,
  previousBlockedReason?: string,
): boolean {
  if (!NOTIFY_ON_STATUSES.has(status)) {
    return false;
  }
  if (status !== previousStatus) {
    return true;
  }
  return blockedReason !== previousBlockedReason;
}

function formatMessage(event: AgentEvent): { title: string; message: string } {
  const title = `TaskSwarm: ${event.session_id} ${event.status}`;
  const parts = [`repo: ${event.repo}`, `agent: ${event.agent_type}`];
  if (event.blocked_reason) {
    parts.push(`reason: ${event.blocked_reason}`);
  }
  return { title, message: parts.join(' | ') };
}

/**
 * Evaluates an event against its session's previous status/blocked_reason
 * and fires the enabled notification channels if the transition warrants
 * it. Local OS notification is always-on; ntfy.sh only fires when
 * explicitly opted in.
 */
export function notify(
  event: AgentEvent,
  previousStatus: AgentStatus | undefined,
  previousBlockedReason: string | undefined,
  options: NotifyOptions = {},
): void {
  if (!shouldNotify(event.status, previousStatus, event.blocked_reason, previousBlockedReason)) {
    return;
  }
  const { title, message } = formatMessage(event);
  const osNotifier = options.osNotifier ?? sendOsNotification;
  osNotifier(title, message);

  if (options.ntfy?.enabled && options.ntfy.topicUrl) {
    const ntfySender = options.ntfySender ?? sendNtfyNotification;
    ntfySender(options.ntfy.topicUrl, title, message).catch((error: unknown) => {
      options.onNtfyError?.(error);
    });
  }
}
