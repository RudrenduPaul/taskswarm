import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const BEL = String.fromCharCode(7);

/**
 * Fires a local OS notification. macOS uses `osascript -e 'display
 * notification'` (no extra dependency, ships with the OS). Any other
 * platform falls back to a console message plus a terminal bell -- always
 * self-hosted, always on by default, no third-party relay involved.
 */
export function sendOsNotification(title: string, message: string): void {
  if (platform() === 'darwin') {
    const script = `display notification ${quoteAppleScriptString(message)} with title ${quoteAppleScriptString(title)}`;
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.on('error', () => {
      // osascript missing/unavailable (e.g. sandboxed CI) -- fall back so a
      // notification failure never crashes the server process.
      fallbackNotification(title, message);
    });
    return;
  }
  fallbackNotification(title, message);
}

function fallbackNotification(title: string, message: string): void {
  // BEL is the terminal bell character -- audible/visible cue in most
  // terminal emulators even without a graphical OS notification.
  process.stdout.write(BEL);
  console.log(`[taskswarm] ${title}: ${message}`);
}

function quoteAppleScriptString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
