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

/** True if a transition from `previousStatus` to `status` should notify. */
export function shouldNotify(
  status: AgentStatus,
  previousStatus: AgentStatus | undefined,
): boolean {
  if (!NOTIFY_ON_STATUSES.has(status)) {
    return false;
  }
  // Only notify on the transition into a notify-worthy status, not on every
  // subsequent event that merely repeats it (e.g. duplicate 'done' events).
  return status !== previousStatus;
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
 * Evaluates an event against its session's previous status and fires the
 * enabled notification channels if the transition warrants it. Local OS
 * notification is always-on; ntfy.sh only fires when explicitly opted in.
 */
export function notify(
  event: AgentEvent,
  previousStatus: AgentStatus | undefined,
  options: NotifyOptions = {},
): void {
  if (!shouldNotify(event.status, previousStatus)) {
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
