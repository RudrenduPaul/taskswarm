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

export interface EventStoreOptions {
  /**
   * Injectable for tests (and anyone wanting to route this into their own
   * logging pipeline). Defaults to writing a line to stderr. Called once
   * per unparseable line encountered during replay -- never throws, so a
   * torn write or a spot of bit-rot is visible to the operator instead of
   * silently erasing history.
   */
  warn?: (message: string) => void;
}

/** Longest raw line content ever echoed back in a corrupt-line warning. */
const CORRUPT_LINE_PREVIEW_LIMIT = 200;

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
  private readonly warn: (message: string) => void;

  constructor(logPath?: string, options: EventStoreOptions = {}) {
    super();
    this.logPath = logPath;
    this.warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
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

  /**
   * Rebuilds in-memory state by replaying every line of the JSONL log.
   * Corrupt/partial lines (e.g. a torn write from a crash mid-append) are
   * skipped rather than failing startup entirely -- durability is
   * best-effort, not a hard guarantee for the last unflushed line -- but
   * each skip is logged so a torn write or bit-rot is visible to the
   * operator instead of silently erasing history.
   */
  private replay(logPath: string): void {
    const raw = readFileSync(logPath, 'utf-8');
    const rawLines = raw.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i] as string;
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = agentEventSchema.parse(JSON.parse(line));
        this.applyToMemory(parsed);
      } catch {
        this.warnCorruptLine(logPath, i + 1, line);
      }
    }
  }

  private warnCorruptLine(logPath: string, lineNumber: number, line: string): void {
    const preview =
      line.length > CORRUPT_LINE_PREVIEW_LIMIT
        ? `${line.slice(0, CORRUPT_LINE_PREVIEW_LIMIT)}... (truncated, ${line.length} chars total)`
        : line;
    this.warn(
      `taskswarm: skipping unparseable event on line ${lineNumber} of ${logPath}: ${preview}`,
    );
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
   * updates in-memory state. Returns the previous status and blocked_reason
   * for the session (both undefined if this is the session's first event)
   * so callers can decide whether a state transition warrants a
   * notification -- notification dedup keys on the (status, blocked_reason)
   * pair together, not status alone, so both are needed.
   */
  append(event: AgentEvent): {
    previousStatus: AgentEvent['status'] | undefined;
    previousBlockedReason: AgentEvent['blocked_reason'] | undefined;
  } {
    const previous = this.sessions.get(event.session_id)?.latest;
    const previousStatus = previous?.status;
    const previousBlockedReason = previous?.blocked_reason;
    if (this.logPath) {
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.applyToMemory(event);
    this.emit('event', event);
    return { previousStatus, previousBlockedReason };
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
