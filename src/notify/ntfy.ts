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
