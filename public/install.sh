#!/usr/bin/env bash
#
# TailDeck one-shot installer for a Linux laptop.
#
#   curl -fsSL https://phy6.github.io/android-to-linux-remote/install.sh | bash
#
# It prepares *any* Linux desktop to be driven from the phone:
#   1. one sudo step: a udev rule so you may create a virtual input device
#   2. installs python-evdev (the same universal uinput path the ProBook uses)
#   3. downloads the daemon and the phone web app
#   4. makes a self-signed certificate for the hotspot https route
#   5. installs and starts a systemd user service so it survives reboots
#
# Run it as your normal desktop user, not root. It asks for sudo once.
set -euo pipefail

REPO_URL="${TAILDECK_REPO_URL:-https://phy6.github.io/android-to-linux-remote}"
BIN_DIR="${HOME}/.local/bin"
DAEMON="${BIN_DIR}/taildeck-daemon.py"
WEBROOT="${HOME}/taildeck-web"
TLS_DIR="${HOME}/.config/taildeck/tls"
UNIT_DIR="${HOME}/.config/systemd/user"
PORT="${TAILDECK_PORT:-8080}"
TLS_PORT="${TAILDECK_TLS_PORT:-8443}"

log()  { printf '\033[1;36m[TailDeck]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[TailDeck]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[TailDeck]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] && die "Run this as your normal desktop user, not root (it will sudo when needed)."
have curl || die "curl is required. Install it and re-run."

# --- package manager -------------------------------------------------------
PKG=""
for c in apt-get dnf pacman zypper; do
  if have "$c"; then PKG="$c"; break; fi
done

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  have sudo || die "sudo is required for the one-time input permission. Install it and re-run."
  SUDO="sudo"
fi

pkg_install() {
  case "$PKG" in
    apt-get) $SUDO apt-get install -y --no-install-recommends "$@" ;;
    dnf)     $SUDO dnf install -y "$@" ;;
    pacman)  $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper)  $SUDO zypper --non-interactive install "$@" ;;
    *)       return 1 ;;
  esac
}

# --- 1. Python 3 -----------------------------------------------------------
if ! have python3; then
  log "Installing Python 3..."
  case "$PKG" in
    apt-get) pkg_install python3 ;;
    dnf)     pkg_install python3 ;;
    pacman)  pkg_install python ;;
    zypper)  pkg_install python3 ;;
    *) die "No python3 and no known package manager. Install Python 3 manually." ;;
  esac
fi
PY="$(command -v python3)"

# --- 2. One sudo step: let the user drive /dev/uinput -----------------------
log "Requesting sudo once, to allow a virtual input device (the only privileged step)..."
RULE=/etc/udev/rules.d/60-taildeck-uinput.rules
printf '%s\n' \
  '# TailDeck: let the logged-in user create a virtual input device.' \
  'KERNEL=="uinput", MODE="0660", GROUP="input", TAG+="uaccess", OPTIONS+="static_node=uinput"' \
  | $SUDO tee "$RULE" >/dev/null
printf 'uinput\n' | $SUDO tee /etc/modules-load.d/uinput.conf >/dev/null
$SUDO modprobe uinput 2>/dev/null || true
$SUDO udevadm control --reload-rules 2>/dev/null || true
$SUDO udevadm trigger 2>/dev/null || true
# Keep the service running when nobody is logged in at the console.
$SUDO loginctl enable-linger "$USER" 2>/dev/null || warn "Could not enable linger; the daemon stops when you log out."

# --- 3. Input backend: python-evdev (universal uinput, X11 + Wayland) --------
if "$PY" -c 'import evdev' 2>/dev/null; then
  log "python-evdev already present."
else
  log "Installing python-evdev..."
  case "$PKG" in
    apt-get) pkg_install python3-evdev || true ;;
    dnf)     pkg_install python3-evdev || true ;;
    pacman)  pkg_install python-evdev || true ;;
    zypper)  pkg_install python3-evdev || true ;;
  esac
  if ! "$PY" -c 'import evdev' 2>/dev/null; then
    log "Falling back to pip for python-evdev..."
    "$PY" -m pip --version >/dev/null 2>&1 || pkg_install python3-pip || true
    "$PY" -m pip install --user evdev 2>/dev/null \
      || "$PY" -m pip install --user --break-system-packages evdev 2>/dev/null \
      || warn "Could not install python-evdev; the daemon will fall back to ydotool/xdotool if present."
  fi
fi

# --- 4. Daemon + phone web app ---------------------------------------------
mkdir -p "$BIN_DIR"
log "Downloading the daemon..."
curl -fsSL "${REPO_URL}/taildeck-daemon.py" -o "$DAEMON"
chmod +x "$DAEMON"

log "Downloading the phone web app..."
mkdir -p "$WEBROOT"
if curl -fsSL "${REPO_URL}/taildeck-web.tar.gz" -o /tmp/taildeck-web.tar.gz; then
  tar xzf /tmp/taildeck-web.tar.gz -C "$WEBROOT"
  rm -f /tmp/taildeck-web.tar.gz
else
  warn "Web app bundle unavailable; the phone can still load the app from GitHub Pages."
fi

# --- 5. Self-signed certificate for the hotspot https route -----------------
mkdir -p "$TLS_DIR"
if [ ! -f "$TLS_DIR/taildeck.crt" ]; then
  if have openssl; then
    log "Generating a self-signed certificate..."
    SAN="DNS:localhost,IP:127.0.0.1,DNS:$(hostname)"
    if have tailscale; then
      TN="$(tailscale status --json 2>/dev/null \
        | "$PY" -c 'import sys,json; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
      [ -n "$TN" ] && SAN="${SAN},DNS:${TN}"
    fi
    for ip in $(hostname -I 2>/dev/null || true); do
      case "$ip" in
        *.*.*.*) SAN="${SAN},IP:${ip}" ;;
        *:*)     SAN="${SAN},IP:${ip}" ;;
      esac
    done
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$TLS_DIR/taildeck.key" -out "$TLS_DIR/taildeck.crt" \
      -subj "/CN=taildeck" -addext "subjectAltName=${SAN}" >/dev/null 2>&1 \
      && log "Certificate written to ${TLS_DIR}" \
      || warn "Could not create a certificate; https stays off, http still works."
  else
    warn "openssl not found; https stays off, http still works."
  fi
fi

# --- 6. systemd user service -----------------------------------------------
if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  log "Installing the systemd user service..."
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/taildeck.service" <<UNIT
[Unit]
Description=TailDeck Linux Remote daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1
Environment=TAILDECK_PORT=${PORT}
Environment=YDOTOOL_SOCKET=%t/.ydotool_socket
ExecStart=${PY} %h/.local/bin/taildeck-daemon.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now taildeck.service
  systemctl --user restart taildeck.service
else
  warn "No systemd user session; start it yourself: ${DAEMON}"
fi

# --- Done -------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TN=""
if have tailscale; then
  TN="$(tailscale status --json 2>/dev/null \
    | "$PY" -c 'import sys,json; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
fi

echo
log "TailDeck is installed and running."
echo
echo "  Open one of these on your phone (accept the certificate warning once):"
[ -n "$IP" ] && echo "    https://${IP}:${TLS_PORT}/     same Wi-Fi  — control + dictation"
[ -n "$IP" ] && echo "    http://${IP}:${PORT}/      same Wi-Fi  — control only"
[ -n "$TN" ] && echo "    https://${TN}/         Tailscale   — works from anywhere"
echo
echo "  The app loads from this laptop and connects to it automatically."
echo "  Logs:  journalctl --user -u taildeck.service -f"
echo "  Stop:  systemctl --user stop taildeck.service"
