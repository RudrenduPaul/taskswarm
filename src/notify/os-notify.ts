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

// Strips ANSI/terminal control sequences (ESC-prefixed CSI/OSC sequences and
// raw control characters other than tab/newline) before writing
// event-derived text to a real terminal. Event fields (session_id, repo,
// blocked_reason) can originate from an authenticated but otherwise
// untrusted /events caller, so this fallback -- unlike the escaped
// AppleScript path -- must not pass them through raw.
const CONTROL_SEQUENCE_PATTERN =
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars is the point
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeForTerminal(value: string): string {
  return value.replace(CONTROL_SEQUENCE_PATTERN, '');
}

function fallbackNotification(title: string, message: string): void {
  // BEL is the terminal bell character -- audible/visible cue in most
  // terminal emulators even without a graphical OS notification.
  process.stdout.write(BEL);
  console.log(`[taskswarm] ${sanitizeForTerminal(title)}: ${sanitizeForTerminal(message)}`);
}

function quoteAppleScriptString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
