import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent } from '../schema/events.js';
import { agentEventSchema } from '../schema/events.js';

/** Latest known state for a session plus its full event history (oldest first). */
export interface SessionState {
  session_id: string;
  latest: AgentEvent;
  history: AgentEvent[];
}

/**
 * In-memory event store keyed by session_id, backed by an append-only JSONL
 * log on disk for durability across restarts. No embedded database: this is
 * a deliberate choice to keep the tool lightweight, dependency-free, and
 * ARM-friendly (no native binary compile step).
 *
 * Emits 'event' with the appended AgentEvent whenever a new event lands, so
 * the HTTP layer can fan it out to connected /live clients.
 */
export class EventStore extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly logPath: string | undefined;

  constructor(logPath?: string) {
    super();
    this.logPath = logPath;
    if (this.logPath) {
      this.ensureLogFile(this.logPath);
      this.replay(this.logPath);
    }
  }

  private ensureLogFile(logPath: string): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(logPath)) {
      closeSync(openSync(logPath, 'a', 0o600));
    }
  }

  /** Rebuilds in-memory state by replaying every line of the JSONL log. */
  private replay(logPath: string): void {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = agentEventSchema.parse(JSON.parse(line));
        this.applyToMemory(parsed);
      } catch {
        // Skip corrupt/partial lines (e.g. a torn write from a crash mid-append)
        // rather than failing startup entirely -- durability best-effort, not
        // a hard guarantee for the last unflushed line.
      }
    }
  }

  private applyToMemory(event: AgentEvent): void {
    const existing = this.sessions.get(event.session_id);
    if (existing) {
      existing.history.push(event);
      existing.latest = event;
    } else {
      this.sessions.set(event.session_id, {
        session_id: event.session_id,
        latest: event,
        history: [event],
      });
    }
  }

  /**
   * Appends a validated event to the log (if persistence is enabled) and
   * updates in-memory state. Returns the previous status for the session
   * (undefined if this is the session's first event) so callers can decide
   * whether a state transition warrants a notification.
   */
  append(event: AgentEvent): { previousStatus: AgentEvent['status'] | undefined } {
    const previousStatus = this.sessions.get(event.session_id)?.latest.status;
    if (this.logPath) {
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.applyToMemory(event);
    this.emit('event', event);
    return { previousStatus };
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** All tracked sessions' latest state, sorted most-recently-updated first. */
  listSessions(): SessionState[] {
    return [...this.sessions.values()].sort(
      (a, b) => Date.parse(b.latest.timestamp) - Date.parse(a.latest.timestamp),
    );
  }

  size(): number {
    return this.sessions.size;
  }
}
