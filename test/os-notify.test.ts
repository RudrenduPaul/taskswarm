import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:os', () => ({ platform: () => 'linux' }));

import { sendOsNotification } from '../src/notify/os-notify.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendOsNotification fallback sanitizing', () => {
  it('strips ANSI CSI and OSC sequences from event-derived text', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    sendOsNotification('T\x1b[31mitle', 'msg\x1b]0;evil\x07 ok\x1b]0;evil2\x1b\\ done');
    expect(log).toHaveBeenCalledWith('[taskswarm] Title: msg ok done');
  });

  it('handles many unterminated OSC introducers in linear time', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const hostile = '\x1b]'.repeat(50_000);
    const start = Date.now();
    sendOsNotification('t', hostile);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
