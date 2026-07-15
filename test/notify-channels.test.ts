import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type * as NodeOs from 'node:os';
import type * as NodeChildProcess from 'node:child_process';

const platformMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, platform: platformMock };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: spawnMock };
});

describe('sendOsNotification', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    platformMock.mockReset();
    spawnMock.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    vi.resetModules();
  });

  it('shells out to osascript on darwin', async () => {
    platformMock.mockReturnValue('darwin');
    const fakeChild = new EventEmitter();
    spawnMock.mockReturnValue(fakeChild);

    const { sendOsNotification } = await import('../src/notify/os-notify.js');
    sendOsNotification('Title', 'Message');

    expect(spawnMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('display notification')],
      { stdio: 'ignore' },
    );
  });

  it('falls back to console + bell if osascript errors on darwin', async () => {
    platformMock.mockReturnValue('darwin');
    const fakeChild = new EventEmitter();
    spawnMock.mockReturnValue(fakeChild);

    const { sendOsNotification } = await import('../src/notify/os-notify.js');
    sendOsNotification('Title', 'Message');
    fakeChild.emit('error', new Error('osascript not found'));

    expect(writeSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Title: Message'));
  });

  it('falls back to console + bell on non-darwin platforms', async () => {
    platformMock.mockReturnValue('linux');

    const { sendOsNotification } = await import('../src/notify/os-notify.js');
    sendOsNotification('Title', 'Message');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Title: Message'));
  });

  it('escapes quotes and backslashes when building the AppleScript string', async () => {
    platformMock.mockReturnValue('darwin');
    const fakeChild = new EventEmitter();
    spawnMock.mockReturnValue(fakeChild);

    const { sendOsNotification } = await import('../src/notify/os-notify.js');
    sendOsNotification('Ti"tle', 'Mes\\sage');

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toContain('\\"tle');
    expect(args[1]).toContain('\\\\sage');
  });
});
