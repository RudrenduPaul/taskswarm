import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEventInputSchema, toAgentEvent } from '../schema/events.js';
import type { AgentEvent } from '../schema/events.js';
import type { EventStore } from './event-store.js';
import { extractBearerToken, tokensMatch } from './auth.js';
import { notify } from '../notify/index.js';
import type { NotifyOptions } from '../notify/index.js';

const MAX_BODY_BYTES = 64 * 1024; // 64KiB is generous for a single event envelope

const uiDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'ui');

export interface HttpServerOptions {
  store: EventStore;
  token: string;
  notifyOptions?: NotifyOptions;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage, token: string, url: URL): boolean {
  const headerToken = extractBearerToken(req.headers.authorization);
  if (headerToken && tokensMatch(headerToken, token)) {
    return true;
  }
  // SSE clients (EventSource) cannot set custom headers, so /live also
  // accepts the token as a query parameter. Documented trade-off: fine for
  // a server that binds to 127.0.0.1 by default; callers who bind to a LAN
  // address should be aware the token can appear in local access logs.
  const queryToken = url.searchParams.get('token');
  if (queryToken && tokensMatch(queryToken, token)) {
    return true;
  }
  return false;
}

/** Creates (but does not start listening on) the TaskSwarm HTTP+SSE server. */
export function createHttpServer(options: HttpServerOptions): Server {
  const { store, token } = options;
  const sseClients = new Set<ServerResponse>();

  store.on('event', (event: AgentEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(frame);
    }
  });

  return createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal server error' });
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      serveIndex(res);
      return;
    }

    if (url.pathname === '/events') {
      if (!isAuthorized(req, token, url)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (method === 'POST') {
        await handlePostEvent(req, res);
        return;
      }
      if (method === 'GET') {
        handleGetEvents(res);
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (url.pathname === '/live' && method === 'GET') {
      if (!isAuthorized(req, token, url)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      handleLive(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function serveIndex(res: ServerResponse): void {
    try {
      const html = readFileSync(join(uiDir, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      sendJson(res, 500, { error: 'ui assets not found' });
    }
  }

  async function handlePostEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, { error: 'request body too large' });
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const parseResult = agentEventInputSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      sendJson(res, 400, { error: 'invalid event', details: parseResult.error.flatten() });
      return;
    }

    const event = toAgentEvent(parseResult.data);
    const { previousStatus, previousBlockedReason } = store.append(event);
    notify(event, previousStatus, previousBlockedReason, options.notifyOptions);

    sendJson(res, 201, event);
  }

  function handleGetEvents(res: ServerResponse): void {
    sendJson(res, 200, { sessions: store.listSessions() });
  }

  function handleLive(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
  }
}
