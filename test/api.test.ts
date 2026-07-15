import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../src/server/http-server.js';
import { EventStore } from '../src/server/event-store.js';

const TOKEN = 'test-token-0123456789abcdef';

function validEventInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    repo: '/repo',
    agent_type: 'generic',
    status: 'running',
    ...overrides,
  };
}

describe('HTTP API', () => {
  let store: EventStore;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = new EventStore(); // in-memory only, no log file
    server = createHttpServer({ store, token: TOKEN, notifyOptions: { osNotifier: () => {} } });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe('auth', () => {
    it('rejects POST /events with no Authorization header', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validEventInput()),
      });
      expect(res.status).toBe(401);
    });

    it('rejects POST /events with an incorrect token', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
        body: JSON.stringify(validEventInput()),
      });
      expect(res.status).toBe(401);
    });

    it('rejects GET /events without a token', async () => {
      const res = await fetch(`${baseUrl}/events`);
      expect(res.status).toBe(401);
    });

    it('accepts a correct bearer token', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /events', () => {
    it('ingests a valid event and returns 201 with the stored event', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(validEventInput({ status: 'blocked', blocked_reason: 'stuck' })),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { session_id: string; status: string; event_id: string };
      expect(body.session_id).toBe('s1');
      expect(body.status).toBe('blocked');
      expect(body.event_id).toBeTruthy();
      expect(store.getSession('s1')?.latest.status).toBe('blocked');
    });

    it('rejects an event with an invalid status with 400', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(validEventInput({ status: 'sleeping' })),
      });
      expect(res.status).toBe(400);
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('rejects a missing required field with 400', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ repo: '/repo', agent_type: 'generic', status: 'running' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /events', () => {
    it('lists ingested sessions sorted by most recent', async () => {
      await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(validEventInput({ session_id: 'old' })),
      });
      await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(validEventInput({ session_id: 'new' })),
      });

      const res = await fetch(`${baseUrl}/events`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = (await res.json()) as { sessions: Array<{ session_id: string }> };
      expect(body.sessions.map((s) => s.session_id)).toEqual(['new', 'old']);
    });
  });

  describe('static UI', () => {
    it('serves the status page at GET /', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('TaskSwarm');
    });
  });

  describe('GET /live', () => {
    it('rejects without a valid token', async () => {
      const res = await fetch(`${baseUrl}/live`);
      expect(res.status).toBe(401);
    });

    it('accepts a token via query string and streams events as SSE', async () => {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/live?token=${encodeURIComponent(TOKEN)}`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Drain the initial ": connected" comment frame.
      const initial = await reader.read();
      expect(decoder.decode(initial.value)).toContain('connected');

      // Trigger an event and confirm it arrives over the stream.
      await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(validEventInput({ session_id: 'live-1' })),
      });

      const next = await reader.read();
      const text = decoder.decode(next.value);
      expect(text).toContain('data:');
      expect(text).toContain('live-1');

      controller.abort();
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for an unknown path', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist`);
      expect(res.status).toBe(404);
    });

    it('returns 405 for an unsupported method on /events', async () => {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
    });
  });
});
