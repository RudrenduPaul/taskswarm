import type { AgentEvent, AgentEventInput } from '../schema/events.js';
import type { SessionState } from '../server/event-store.js';
import type { TaskSwarmConfig } from '../server/config.js';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly context?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function baseUrl(config: Pick<TaskSwarmConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}`;
}

/** POSTs an event to the local TaskSwarm server. Throws ApiClientError on any failure. */
export async function postEvent(
  config: Pick<TaskSwarmConfig, 'host' | 'port' | 'token'>,
  input: AgentEventInput,
): Promise<AgentEvent> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new ApiClientError(
      `could not reach TaskSwarm server at ${baseUrl(config)} -- is it running? (\`taskswarm start\`)`,
      error,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ApiClientError(`server rejected event (${response.status}): ${body}`);
  }
  return (await response.json()) as AgentEvent;
}

/** GETs current session states from the local TaskSwarm server. */
export async function getSessions(
  config: Pick<TaskSwarmConfig, 'host' | 'port' | 'token'>,
): Promise<SessionState[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}/events`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  } catch (error) {
    throw new ApiClientError(`could not reach TaskSwarm server at ${baseUrl(config)}`, error);
  }
  if (!response.ok) {
    throw new ApiClientError(`server returned ${response.status}`);
  }
  const data = (await response.json()) as { sessions: SessionState[] };
  return data.sessions;
}
