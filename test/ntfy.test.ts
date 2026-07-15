import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendNtfyNotification } from '../src/notify/ntfy.js';

describe('sendNtfyNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the message with title header to the given topic URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendNtfyNotification('https://ntfy.sh/my-topic', 'Hello', 'World');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.sh/my-topic',
      expect.objectContaining({
        method: 'POST',
        body: 'World',
        headers: expect.objectContaining({ Title: 'Hello' }) as unknown,
      }),
    );
  });

  it('throws when ntfy.sh responds with a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' })),
    );

    await expect(sendNtfyNotification('https://ntfy.sh/x', 'T', 'M')).rejects.toThrow(
      /ntfy\.sh notification failed/,
    );
  });
});
