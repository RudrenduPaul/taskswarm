const PRIVATE_OR_LINK_LOCAL_IPV4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // includes cloud metadata endpoints, e.g. 169.254.169.254
  /^0\./,
];

/**
 * Rejects a topic URL that isn't https (unless it targets loopback, useful
 * for a local self-hosted ntfy instance during testing) or that targets a
 * private/link-local address -- guards against a misconfigured or tampered
 * config.json silently sending event data (repo path, session id, blocked
 * reason) in plaintext or to an internal/metadata endpoint.
 */
export function validateNtfyUrl(topicUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(topicUrl);
  } catch {
    throw new Error(`invalid ntfy topic URL: "${topicUrl}"`);
  }
  const hostname = parsed.hostname;
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(
      `ntfy topic URL must use https:// (got "${parsed.protocol}") -- plaintext http:// is only allowed for a loopback host, to avoid sending notification content unencrypted over a network`,
    );
  }
  if (!isLoopback && PRIVATE_OR_LINK_LOCAL_IPV4.some((pattern) => pattern.test(hostname))) {
    throw new Error(
      `ntfy topic URL host "${hostname}" is a private/link-local address -- refusing to send notifications there by default`,
    );
  }
  return parsed;
}

/**
 * ntfy.sh channel -- explicitly opt-in only. Never called unless the caller
 * has an enabled ntfy config with a topic URL; TaskSwarm's "self-hosted by
 * default" claim depends on this never firing implicitly.
 */
export async function sendNtfyNotification(
  topicUrl: string,
  title: string,
  message: string,
): Promise<void> {
  validateNtfyUrl(topicUrl);
  const response = await fetch(topicUrl, {
    method: 'POST',
    body: message,
    headers: {
      Title: title,
      Priority: 'default',
    },
  });
  if (!response.ok) {
    throw new Error(`ntfy.sh notification failed: ${response.status} ${response.statusText}`);
  }
}
