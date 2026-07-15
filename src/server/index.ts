import type { Server } from 'node:http';
import { EventStore } from './event-store.js';
import { createHttpServer } from './http-server.js';
import { getEventLogPath, loadOrCreateConfig } from './config.js';
import type { TaskSwarmConfig } from './config.js';

export interface RunningServer {
  server: Server;
  store: EventStore;
  config: TaskSwarmConfig;
  url: string;
  close: () => Promise<void>;
}

export interface StartServerOptions {
  /** Override the persisted config (mainly for tests). If omitted, loads/creates ~/.taskswarm/config.json. */
  config?: TaskSwarmConfig;
  /** Override the JSONL log path (mainly for tests). Pass undefined to disable persistence entirely. */
  logPath?: string | null;
}

/** Boots the event store + HTTP/SSE server and starts listening. */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const config = options.config ?? loadOrCreateConfig();
  const logPath = options.logPath === null ? undefined : (options.logPath ?? getEventLogPath());

  const store = new EventStore(logPath);
  const server = createHttpServer({
    store,
    token: config.token,
    notifyOptions: {
      ...(config.ntfy.enabled ? { ntfy: config.ntfy } : {}),
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const url = `http://${config.host}:${config.port}/?token=${encodeURIComponent(config.token)}`;

  return {
    server,
    store,
    config,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
