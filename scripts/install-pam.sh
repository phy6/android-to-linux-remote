#!/usr/bin/env bash
# Install the TailDeck phone-unlock / admin-approval PAM helpers.
#
# This is the ONE part of TailDeck that needs root. Run it plain to stage
# everything safely (keys, helper, beep cue, a THROWAWAY test service) without
# touching the live login stack; add --wire to also wire the real services.
#
#   sudo scripts/install-pam.sh [--user NAME] [--wire] [--uninstall]
#
# --wire edits, with backups:
#   /etc/pam.d/xfce4-screensaver   lock screen  -> phone unlocks the screen
#   /etc/pam.d/lightdm             greeter      -> phone logs in
#   /etc/pam.d/polkit-1 (created)  admin prompts-> beep + phone approves pkexec
# Every wired line is 'sufficient', so a missing phone/daemon always falls
# through to the normal password path: it can never lock anyone out.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_SRC="$SRC_DIR/taildeck-pam"
BEEP_SRC="$SRC_DIR/taildeck-beep"
UNLOCK_LINE="auth    sufficient  pam_exec.so quiet /usr/local/sbin/taildeck-pam"
BEEP_LINE="auth    optional    pam_exec.so quiet /usr/local/sbin/taildeck-beep"
WIRED_SERVICES="xfce4-screensaver lightdm"

USER_NAME="${SUDO_USER:-}"
WIRE=0
UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --user) USER_NAME="${2:-}"; shift 2 ;;
        --wire) WIRE=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "This installer must run as root:  sudo scripts/install-pam.sh" >&2
    exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
    rm -f /usr/local/sbin/taildeck-pam /usr/local/sbin/taildeck-beep \
          /etc/pam.d/taildeck-test /etc/taildeck/pam.key
    [ -n "$USER_NAME" ] && rm -f "/home/$USER_NAME/.config/taildeck/pam.key" || true
    rmdir /etc/taildeck 2>/dev/null || true
    for svc in $WIRED_SERVICES; do
        [ -e "/etc/pam.d/$svc.taildeck.bak" ] && mv -f "/etc/pam.d/$svc.taildeck.bak" "/etc/pam.d/$svc"
    done
    if [ -e /etc/pam.d/polkit-1.taildeck.bak ]; then
        mv -f /etc/pam.d/polkit-1.taildeck.bak /etc/pam.d/polkit-1
    else
        rm -f /etc/pam.d/polkit-1
    fi
    echo "Removed the helpers, keys and wired PAM edits (restored any backups)."
    exit 0
fi

if [ -z "$USER_NAME" ] || ! id "$USER_NAME" >/dev/null 2>&1; then
    echo "Could not determine the target user. Pass --user NAME." >&2
    exit 1
fi

user_home="$(getent passwd "$USER_NAME" | cut -d: -f6)"
user_group="$(id -gn "$USER_NAME")"

echo "== TailDeck PAM install =="
echo "user:    $USER_NAME ($user_home)"
echo "helper:  /usr/local/sbin/taildeck-pam"
echo "beep:    /usr/local/sbin/taildeck-beep (fires on admin prompts)"
echo "test:    /etc/pam.d/taildeck-test"
[ "$WIRE" -eq 1 ] && echo "wire:    $WIRED_SERVICES + polkit-1 (with .taildeck.bak backups)"
echo

# 1. Shared secret ----------------------------------------------------------
umask 077
key="$(openssl rand -hex 48)"
install -d -m 0755 /etc/taildeck
printf '%s\n' "$key" > /etc/taildeck/pam.key
chown root:root /etc/taildeck/pam.key
chmod 0400 /etc/taildeck/pam.key
install -d -m 0700 -o "$USER_NAME" -g "$user_group" "$user_home/.config/taildeck"
printf '%s\n' "$key" > "$user_home/.config/taildeck/pam.key"
chown "$USER_NAME:$user_group" "$user_home/.config/taildeck/pam.key"
chmod 0600 "$user_home/.config/taildeck/pam.key"
echo "[1/4] wrote root key and the user's twin"

# 2. Helpers ----------------------------------------------------------------
install -m 0755 -o root -g root "$HELPER_SRC" /usr/local/sbin/taildeck-pam
install -m 0755 -o root -g root "$BEEP_SRC" /usr/local/sbin/taildeck-beep
echo "[2/4] installed taildeck-pam and taildeck-beep"

# 3. Throwaway test service -------------------------------------------------
cat > /etc/pam.d/taildeck-test <<EOF
# TailDeck phone-unlock test service. Safe to delete.
$UNLOCK_LINE
auth    include      common-auth
account include      common-account
session include      common-session
EOF
chmod 0644 /etc/pam.d/taildeck-test
echo "[3/4] installed /etc/pam.d/taildeck-test"

# 4. Optionally wire the real services --------------------------------------
insert_before() {  # file, line, needle
    awk -v L="$2" -v N="$3" 'BEGIN{d=0} { if(!d && index($0,N)){ print L; d=1 } print }' "$1" > "$1.new"
    install -m 0644 -o root -g root "$1.new" "$1"
    rm -f "$1.new"
}

if [ "$WIRE" -eq 1 ]; then
    for svc in $WIRED_SERVICES; do
        f="/etc/pam.d/$svc"
        [ -e "$f" ] || { echo "skip: $f not present"; continue; }
        cp -a "$f" "$f.taildeck.bak"
        insert_before "$f" "$UNLOCK_LINE" "common-auth"
    done
    if [ -e /etc/pam.d/polkit-1 ]; then cp -a /etc/pam.d/polkit-1 /etc/pam.d/polkit-1.taildeck.bak
    else rm -f /etc/pam.d/polkit-1.taildeck.bak; fi
    cat > /etc/pam.d/polkit-1 <<EOF
# TailDeck: audible cue + phone approval for admin (polkit) prompts.
# Created by scripts/install-pam.sh. Delete to restore /etc/pam.d/other.
$BEEP_LINE
$UNLOCK_LINE
auth    include     common-auth
account include     common-account
session include     common-session
EOF
    chmod 0644 /etc/pam.d/polkit-1
    echo "[4/4] wired $WIRED_SERVICES and created /etc/pam.d/polkit-1"
else
    echo "[4/4] skipped wiring (pass --wire to enable lock screen, greeter, polkit)"
fi

echo
echo "Next:"
echo "  1. Restart the daemon so it serves the consume endpoint (already 1.4.0+):"
echo "       systemctl --user restart taildeck"
echo "  2. Approve from the phone, then within 30s try the target:"
echo "       pamtester taildeck-test $USER_NAME authenticate        # staged test"
[ "$WIRE" -eq 1 ] && echo "       pamtester polkit-1 $USER_NAME authenticate            # admin prompt stack"
echo
echo "Rollback everything:  sudo scripts/install-pam.sh --user $USER_NAME --uninstall"
