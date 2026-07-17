"""Fires a local OS notification. macOS uses `osascript -e 'display
notification'` (no extra dependency, ships with the OS). Any other platform
falls back to a console message plus a terminal bell -- always self-hosted,
always on by default, no third-party relay involved. Ported from
src/notify/os-notify.ts."""
from __future__ import annotations

import platform
import subprocess
import sys

_BEL = chr(7)


def send_os_notification(title: str, message: str) -> None:
    if platform.system() == "Darwin":
        script = (
            f"display notification {_quote_applescript_string(message)} "
            f"with title {_quote_applescript_string(title)}"
        )
        try:
            subprocess.run(
                ["osascript", "-e", script],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            # osascript missing/unavailable (e.g. sandboxed CI) -- fall back
            # so a notification failure never crashes the server process.
            _fallback_notification(title, message)
        return
    _fallback_notification(title, message)


def _fallback_notification(title: str, message: str) -> None:
    # BEL is the terminal bell character -- audible/visible cue in most
    # terminal emulators even without a graphical OS notification.
    sys.stdout.write(_BEL)
    print(f"[taskswarm] {title}: {message}")


def _quote_applescript_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
