#!/usr/bin/env bash
# Run a command as root via pkexec, but make a sound first so you know the
# password prompt is coming (and bring the display env along for the prompt).
#
# Usage:  scripts/with-root.sh <command> [args...]
# Example: scripts/with-root.sh scripts/install-pam.sh --user martin
set -euo pipefail

beep() {
    if command -v paplay >/dev/null 2>&1 \
        && [ -r /usr/share/sounds/freedesktop/stereo/bell.oga ]; then
        paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || true
    elif command -v aplay >/dev/null 2>&1 \
        && [ -r /usr/share/sounds/alsa/Front_Center.wav ]; then
        aplay -q /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null || true
    else
        printf '\a' >/dev/tty 2>/dev/null || printf '\a' || true
    fi
}

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <command> [args...]" >&2
    exit 2
fi

: "${DISPLAY:=:0.0}"
export DISPLAY
[ -r "$HOME/.Xauthority" ] && export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

echo "Beep -> approve the password prompt to run as root: $*"
beep
sleep 0.4
exec pkexec "$@"
