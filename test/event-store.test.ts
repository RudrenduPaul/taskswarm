import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/server/event-store.js';
import type { AgentEvent } from '../src/schema/events.js';

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: 'session-1',
    repo: '/repo/a',
    agent_type: 'generic',
    status: 'queued',
    timestamp: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  };
}

describe('EventStore', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskswarm-store-'));
    logPath = join(dir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when no events have been appended', () => {
    const store = new EventStore(logPath);
    expect(store.size()).toBe(0);
    expect(store.listSessions()).toEqual([]);
  });

  it('tracks latest state and full history per session', () => {
    const store = new EventStore(logPath);
    const first = makeEvent({ status: 'queued', timestamp: '2026-01-01T00:00:00.000Z' });
    const second = makeEvent({ status: 'running', timestamp: '2026-01-01T00:01:00.000Z' });

    store.append(first);
    store.append(second);

    const session = store.getSession('session-1');
    expect(session?.latest).toEqual(second);
    expect(session?.history).toEqual([first, second]);
    expect(store.size()).toBe(1);
  });

  it('tracks multiple independent sessions', () => {
    const store = new EventStore(logPath);
    store.append(makeEvent({ session_id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }));
    store.append(makeEvent({ session_id: 'b', timestamp: '2026-01-01T00:00:01.000Z' }));
    expect(store.size()).toBe(2);
  });

  it('returns the previous status from append() so callers can detect transitions', () => {
    const store = new EventStore(logPath);
    const r1 = store.append(makeEvent({ status: 'queued', timestamp: '2026-01-01T00:00:00.000Z' }));
    expect(r1.previousStatus).toBeUndefined();

    const r2 = store.append(
      makeEvent({ status: 'running', timestamp: '2026-01-01T00:01:00.000Z' }),
    );
    expect(r2.previousStatus).toBe('queued');

    const r3 = store.append(
      makeEvent({ status: 'blocked', timestamp: '2026-01-01T00:02:00.000Z' }),
    );
    expect(r3.previousStatus).toBe('running');
  });

  it('sorts listSessions by most-recently-updated first', () => {
    const store = new EventStore(logPath);
    store.append(makeEvent({ session_id: 'old', timestamp: '2026-01-01T00:00:00.000Z' }));
    store.append(makeEvent({ session_id: 'new', timestamp: '2026-01-02T00:00:00.000Z' }));
    store.append(makeEvent({ session_id: 'middle', timestamp: '2026-01-01T12:00:00.000Z' }));

    const sessions = store.listSessions();
    expect(sessions.map((s) => s.session_id)).toEqual(['new', 'middle', 'old']);
  });

  it('emits an "event" for every appended event', () => {
    const store = new EventStore(logPath);
    const received: AgentEvent[] = [];
    store.on('event', (event: AgentEvent) => received.push(event));

    const event = makeEvent();
    store.append(event);

    expect(received).toEqual([event]);
  });

  it('persists events to the JSONL log file', () => {
    const store = new EventStore(logPath);
    store.append(makeEvent({ session_id: 'a' }));
    store.append(makeEvent({ session_id: 'b' }));

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).session_id).toBe('a');
    expect(JSON.parse(lines[1] as string).session_id).toBe('b');
  });

  it('replays the JSONL log to rebuild in-memory state on startup', () => {
    const first = new EventStore(logPath);
    first.append(
      makeEvent({ session_id: 'a', status: 'queued', timestamp: '2026-01-01T00:00:00.000Z' }),
    );
    first.append(
      makeEvent({ session_id: 'a', status: 'running', timestamp: '2026-01-01T00:01:00.000Z' }),
    );
    first.append(
      makeEvent({ session_id: 'b', status: 'blocked', timestamp: '2026-01-01T00:02:00.000Z' }),
    );

    const replayed = new EventStore(logPath);
    expect(replayed.size()).toBe(2);
    expect(replayed.getSession('a')?.latest.status).toBe('running');
    expect(replayed.getSession('a')?.history).toHaveLength(2);
    expect(replayed.getSession('b')?.latest.status).toBe('blocked');
  });

  it('skips corrupt lines in the log without failing startup', () => {
    const store = new EventStore(logPath);
    store.append(makeEvent({ session_id: 'a' }));
    // Simulate a torn write (e.g. crash mid-append) by hand-appending garbage.
    appendFileSync(logPath, 'not valid json\n');
    appendFileSync(logPath, `${JSON.stringify({ not: 'a valid event' })}\n`);

    const replayed = new EventStore(logPath);
    expect(replayed.size()).toBe(1);
    expect(replayed.getSession('a')).toBeDefined();
  });

  it('works purely in-memory when constructed without a log path', () => {
    const store = new EventStore();
    store.append(makeEvent());
    expect(store.size()).toBe(1);
  });
});
