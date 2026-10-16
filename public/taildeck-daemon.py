#!/usr/bin/env python3
"""
TailDeck Linux Remote Daemon
Supports Wayland & X11 input injection via /dev/uinput, ydotool, xdotool, or evdev.
Zero external dependencies required (uses Python standard library for WebSocket & HTTP).
"""

import sys
import os
import json
import time
import socket
import struct
import urllib.parse
import hashlib
import base64
import threading
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("TAILDECK_PORT", 8080))
DICTATE_HOST = os.environ.get("TAILDECK_DICTATE_HOST", "127.0.0.1")
DICTATE_PORT = int(os.environ.get("TAILDECK_DICTATE_PORT", 8090))

OP_START, OP_STOP, OP_PCM, OP_TEXT, OP_OK = 0x01, 0x02, 0x03, 0x04, 0x01


class DictationBridge:
    """Relays phone PCM from this daemon's websocket to the local vosk
    push-to-talk daemon, which recognises it and types the result itself.

    The transcript comes back on the same socket a beat after release, once the
    daemon finishes its offline re-decode, so the socket is deliberately left
    open past the end of the session and a reader thread owns every read."""

    def __init__(self):
        self.sock = None
        self.lock = threading.Lock()
        self.reader = None
        self.on_text = None

    def start(self):
        self._reset()
        try:
            sock = socket.create_connection((DICTATE_HOST, DICTATE_PORT), timeout=10)
            sock.settimeout(30)
            sock.sendall(bytes([OP_START]))
            if sock.recv(1) != bytes([OP_OK]):
                sock.close()
                return False
            self.sock = sock
            self.reader = threading.Thread(target=self._read_loop, args=(sock,), daemon=True)
            self.reader.start()
            return True
        except Exception as e:
            print(f"[TailDeck] dictation bridge unavailable: {e}")
            self.sock = None
            return False

    def _read_loop(self, sock):
        """Owns every read on this socket. Status bytes are ignored; an OP_TEXT
        frame carries the recognised text."""
        try:
            while True:
                head = self._readn(sock, 1)
                if not head:
                    break
                if head[0] != OP_TEXT:
                    continue
                raw = self._readn(sock, 4)
                if not raw:
                    break
                size = struct.unpack("!I", raw)[0]
                if size <= 0 or size > (1 << 20):
                    break
                payload = self._readn(sock, size)
                if not payload:
                    break
                cb = self.on_text
                if cb is not None:
                    try:
                        cb(payload.decode("utf-8", "replace"))
                    except Exception:
                        pass
        except Exception:
            pass

    @staticmethod
    def _readn(sock, n):
        buf = b""
        while len(buf) < n:
            try:
                part = sock.recv(n - len(buf))
            except Exception:
                return None
            if not part:
                return None
            buf += part
        return buf

    def audio(self, pcm):
        if not self.sock or not pcm:
            return
        try:
            with self.lock:
                self.sock.sendall(bytes([OP_PCM]) + struct.pack("!I", len(pcm)) + pcm)
        except Exception as e:
            print(f"[TailDeck] dictation audio dropped: {e}")
            self._reset()

    def stop(self):
        """End the session but keep the socket alive for the trailing text."""
        if not self.sock:
            return
        try:
            self.sock.sendall(bytes([OP_STOP]))
        except Exception:
            self._reset()

    def _reset(self):
        self.sock = None


DICTATION = DictationBridge()
SESSION_TYPE = os.environ.get("XDG_SESSION_TYPE", "unknown").lower()
BACKEND_NAME = "none"

# --- INPUT BACKEND ABSTRACTION (Wayland & X11 Compatible) ---

class LinuxInputBackend:
    def __init__(self):
        self.backend = None
        self.init_backend()

    def init_backend(self):
        global BACKEND_NAME
        # Priority 1: python-evdev (/dev/uinput) - Universal Wayland & X11 Kernel input
        try:
            import evdev
            from evdev import UInput, ecodes as e
            capabilities = {
                e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL, e.REL_HWHEEL],
                e.EV_KEY: [
                    e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE,
                    e.KEY_LEFTALT, e.KEY_TAB, e.KEY_LEFTSHIFT, e.KEY_LEFTCTRL,
                    e.KEY_ENTER, e.KEY_BACKSPACE, e.KEY_SPACE, e.KEY_ESC,
                    e.KEY_RIGHTCTRL, e.KEY_RIGHTALT, e.KEY_RIGHTSHIFT,
                    e.KEY_LEFTMETA, e.KEY_VOLUMEUP, e.KEY_VOLUMEDOWN, e.KEY_MUTE
                ]
            }
            self.ui = UInput(capabilities, name="taildeck-virtual-device")
            self.backend = "evdev_uinput"
            BACKEND_NAME = "Linux Kernel uinput (Universal Wayland & X11)"
            print(f"[TailDeck] Using /dev/uinput via evdev ({BACKEND_NAME})")
            return
        except Exception as ex:
            pass

        # Priority 2: ydotool (Wayland & X11 native daemon tool)
        if self._command_exists("ydotool"):
            self.backend = "ydotool"
            BACKEND_NAME = "ydotool CLI (Wayland & X11)"
            print(f"[TailDeck] Using ydotool for input ({SESSION_TYPE})")
            return

        # Priority 3: xdotool (X11 only)
        if SESSION_TYPE == "x11" and self._command_exists("xdotool"):
            self.backend = "xdotool"
            BACKEND_NAME = "xdotool CLI (X11 Native)"
            print("[TailDeck] Using xdotool for input (X11)")
            return

        # Priority 4: pyautogui / pynput
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            self.backend = "pyautogui"
            BACKEND_NAME = "PyAutoGUI"
            print("[TailDeck] Using PyAutoGUI fallback")
            return
        except Exception:
            pass

        self.backend = "cli_fallback"
        BACKEND_NAME = "CLI Helper fallback (wtype / xdotool / ydotool)"
        print(f"[TailDeck] Warning: No direct uinput library found. Will try CLI commands ({SESSION_TYPE})")

    def _command_exists(self, cmd):
        return subprocess.call(f"type {cmd}", shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) == 0

    def move_cursor(self, dx: int, dy: int):
        if self.backend == "evdev_uinput":
            from evdev import ecodes as e
            self.ui.write(e.EV_REL, e.REL_X, int(dx))
            self.ui.write(e.EV_REL, e.REL_Y, int(dy))
            self.ui.syn()
        elif self.backend == "ydotool":
            subprocess.run(["ydotool", "mousemove", "-x", str(int(dx)), "-y", str(int(dy))], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "xdotool":
            subprocess.run(["xdotool", "mousemove_relative", "--", str(int(dx)), str(int(dy))], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            pyautogui.moveRel(dx, dy)

    def mouse_click(self, button: str, action: str = "click"):
        btn_map_ydo = {"left": "0x110", "right": "0x111", "middle": "0x112"}
        btn_map_xdo = {"left": "1", "middle": "2", "right": "3"}

        if self.backend == "evdev_uinput":
            from evdev import ecodes as e
            btn_code = e.BTN_LEFT if button == "left" else (e.BTN_RIGHT if button == "right" else e.BTN_MIDDLE)
            if action in ("click", "down"):
                self.ui.write(e.EV_KEY, btn_code, 1)
                self.ui.syn()
            if action in ("click", "up"):
                if action == "click":
                    time.sleep(0.015)
                self.ui.write(e.EV_KEY, btn_code, 0)
                self.ui.syn()
        elif self.backend == "ydotool":
            code = btn_map_ydo.get(button, "0x110")
            if action == "click":
                subprocess.run(["ydotool", "click", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "xdotool":
            code = btn_map_xdo.get(button, "1")
            cmd = "click" if action == "click" else ("mousedown" if action == "down" else "mouseup")
            subprocess.run(["xdotool", cmd, code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            if action == "click":
                pyautogui.click(button=button)
            elif action == "down":
                pyautogui.mouseDown(button=button)
            elif action == "up":
                pyautogui.mouseUp(button=button)

    def scroll(self, dx: int, dy: int):
        if self.backend == "evdev_uinput":
            from evdev import ecodes as e
            if dy != 0:
                self.ui.write(e.EV_REL, e.REL_WHEEL, int(dy))
            if dx != 0:
                self.ui.write(e.EV_REL, e.REL_HWHEEL, int(dx))
            self.ui.syn()
        elif self.backend == "ydotool":
            # ydotool mousemove -w
            step = 1 if dy > 0 else -1
            subprocess.run(["ydotool", "mousemove", "-w", str(step)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "xdotool":
            btn = "4" if dy > 0 else "5"
            subprocess.run(["xdotool", "click", btn], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            pyautogui.scroll(int(dy * 10))

    def app_switch(self, direction: str):
        """
        Rotates between applications:
        'next' (right scroll): Alt+Tab
        'prev' (left scroll): Alt+Shift+Tab
        Wayland & X11 compatible.
        """
        if self.backend == "evdev_uinput":
            from evdev import ecodes as e
            self.ui.write(e.EV_KEY, e.KEY_LEFTALT, 1)
            if direction == "prev":
                self.ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 1)
            self.ui.write(e.EV_KEY, e.KEY_TAB, 1)
            self.ui.syn()
            time.sleep(0.02)
            self.ui.write(e.EV_KEY, e.KEY_TAB, 0)
            if direction == "prev":
                self.ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 0)
            self.ui.write(e.EV_KEY, e.KEY_LEFTALT, 0)
            self.ui.syn()
        elif self.backend == "ydotool":
            # Keycodes: Alt=56, Shift=42, Tab=15
            if direction == "prev":
                subprocess.run(["ydotool", "key", "56:1", "42:1", "15:1", "15:0", "42:0", "56:0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["ydotool", "key", "56:1", "15:1", "15:0", "56:0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "xdotool":
            combo = "alt+shift+Tab" if direction == "prev" else "alt+Tab"
            subprocess.run(["xdotool", "key", combo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            if direction == "prev":
                pyautogui.hotkey('alt', 'shift', 'tab')
            else:
                pyautogui.hotkey('alt', 'tab')

    def type_text(self, text: str):
        """Types string input (e.g. from dictation). Handles Wayland and X11 clipboard/typing."""
        # Try clipboard paste first for fast, exact unicode insertion
        if SESSION_TYPE == "wayland" and self._command_exists("wl-copy"):
            try:
                p = subprocess.Popen(["wl-copy"], stdin=subprocess.PIPE)
                p.communicate(input=text.encode('utf-8'))
                # Simulate Ctrl+V / Shift+Insert
                self.key_combo(["ctrl", "v"])
                return
            except Exception:
                pass
        elif SESSION_TYPE == "x11" and self._command_exists("xclip"):
            try:
                p = subprocess.Popen(["xclip", "-selection", "clipboard"], stdin=subprocess.PIPE)
                p.communicate(input=text.encode('utf-8'))
                self.key_combo(["ctrl", "v"])
                return
            except Exception:
                pass

        # Fallback to direct typing
        if self._command_exists("wtype"):
            subprocess.run(["wtype", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "xdotool":
            subprocess.run(["xdotool", "type", "--delay", "12", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "ydotool":
            subprocess.run(["ydotool", "type", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            pyautogui.write(text, interval=0.01)

    def key_combo(self, keys):
        if self.backend == "evdev_uinput":
            from evdev import ecodes as e
            names = {
                "ctrl": e.KEY_LEFTCTRL, "control": e.KEY_LEFTCTRL,
                "ctrl_l": e.KEY_LEFTCTRL, "ctrl_r": e.KEY_RIGHTCTRL, "rctrl": e.KEY_RIGHTCTRL,
                "alt": e.KEY_LEFTALT, "alt_l": e.KEY_LEFTALT, "alt_r": e.KEY_RIGHTALT,
                "shift": e.KEY_LEFTSHIFT, "shift_l": e.KEY_LEFTSHIFT, "shift_r": e.KEY_RIGHTSHIFT,
                "super": e.KEY_LEFTMETA, "meta": e.KEY_LEFTMETA, "win": e.KEY_LEFTMETA,
                "tab": e.KEY_TAB, "return": e.KEY_ENTER, "enter": e.KEY_ENTER,
                "space": e.KEY_SPACE, "esc": e.KEY_ESC, "escape": e.KEY_ESC,
                "backspace": e.KEY_BACKSPACE,
            }
            # Single printable characters, so combos like ctrl+v actually work.
            for i in range(26):
                names[chr(ord("a") + i)] = getattr(e, "KEY_" + chr(ord("A") + i))
            for i in range(10):
                names[str(i)] = getattr(e, "KEY_" + str(i))
            names.update({
                "-": e.KEY_MINUS, "=": e.KEY_EQUAL, "[": e.KEY_LEFTBRACE,
                "]": e.KEY_RIGHTBRACE, ";": e.KEY_SEMICOLON, "'": e.KEY_APOSTROPHE,
                "`": e.KEY_GRAVE, "\\": e.KEY_BACKSLASH, ",": e.KEY_COMMA,
                ".": e.KEY_DOT, "/": e.KEY_SLASH,
            })
            codes = [names[k.lower()] for k in keys if k.lower() in names]
            if not codes:
                return
            for c in codes:
                self.ui.write(e.EV_KEY, c, 1)
            self.ui.syn()
            time.sleep(0.02)
            for c in reversed(codes):
                self.ui.write(e.EV_KEY, c, 0)
            self.ui.syn()
        elif self.backend == "xdotool":
            subprocess.run(["xdotool", "key", "+".join(keys)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "ydotool":
            # Quick hotkey fallback
            pass
        elif self.backend == "pyautogui":
            import pyautogui
            pyautogui.hotkey(*keys)


INPUT_HANDLER = LinuxInputBackend()

# --- STANDALONE RFC6455 WEBSOCKET IMPLEMENTATION (No pip required) ---

# The same port answers plain GETs with the built app, so on a hotspot the
# phone can load it from the laptop itself and talk to it over ws:// with no
# Tailscale, no cellular data and no internet round trip. Set TAILDECK_WEBROOT
# to the directory holding the built index.html to enable it.
WEBROOT = os.environ.get("TAILDECK_WEBROOT", os.path.expanduser("~/taildeck-web"))

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
}


def _http(conn, status, ctype, body, cache="no-cache"):
    head = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Cache-Control: {cache}\r\n"
        "Connection: close\r\n\r\n"
    )
    try:
        conn.sendall(head.encode("utf-8") + body)
    except Exception:
        pass


def serve_static(conn, request_line):
    try:
        target = request_line.split()[1]
    except Exception:
        target = "/"
    target = target.split("?", 1)[0].split("#", 1)[0]
    root = os.path.abspath(WEBROOT)

    if not os.path.isdir(root):
        _http(conn, "404 Not Found", "text/plain; charset=utf-8",
              b"TailDeck: no app published here. Set TAILDECK_WEBROOT.\n")
        return

    rel = urllib.parse.unquote(target).lstrip("/")
    full = os.path.abspath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        full = os.path.join(root, "index.html")   # path traversal guard
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
    if not os.path.isfile(full):
        # Navigations fall back to the app shell; a missing asset is a real 404,
        # otherwise a broken path would quietly return HTML instead of failing.
        if os.path.splitext(full)[1]:
            _http(conn, "404 Not Found", "text/plain; charset=utf-8", b"Not found\n")
            return
        full = os.path.join(root, "index.html")
    if not os.path.isfile(full):
        _http(conn, "404 Not Found", "text/plain; charset=utf-8", b"Not found\n")
        return

    try:
        with open(full, "rb") as fh:
            body = fh.read()
    except Exception:
        _http(conn, "500 Internal Server Error", "text/plain; charset=utf-8", b"Unreadable\n")
        return

    if os.path.basename(full) == "index.html":
        cache = "no-cache"
    elif "/assets/" in full.replace(os.sep, "/"):
        cache = "public, max-age=31536000, immutable"
    else:
        cache = "public, max-age=3600"
    ctype = MIME_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
    _http(conn, "200 OK", ctype, body, cache)


def local_ipv4_addresses():
    """Addresses a phone on the same hotspot could reach the laptop on."""
    found = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except Exception:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        found.add(probe.getsockname()[0])
        probe.close()
    except Exception:
        pass
    return sorted(ip for ip in found if not ip.startswith("127."))


def handle_websocket(conn):
    try:
        data = conn.recv(4096).decode('utf-8', errors='ignore')
        if "Upgrade: websocket" not in data:
            serve_static(conn, data.split("\r\n", 1)[0] if data else "GET / HTTP/1.1")
            conn.close()
            return

        key = None
        for line in data.split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                break

        if not key:
            conn.close()
            return

        # Complete WebSocket handshake
        guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        accept_val = base64.b64encode(hashlib.sha1((key + guid).encode('utf-8')).digest()).decode('utf-8')
        handshake_resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_val}\r\n"
            "\r\n"
        )
        conn.sendall(handshake_resp.encode('utf-8'))

        # Send initial host handshake message
        welcome = {
            "type": "host_info",
            "hostname": socket.gethostname(),
            "os": sys.platform,
            "session": "Wayland" if "wayland" in SESSION_TYPE else ("X11" if "x11" in SESSION_TYPE else "Unknown"),
            "backend": BACKEND_NAME
        }
        send_ws_frame(conn, json.dumps(welcome))

        # Main message processing loop
        while True:
            payload = read_ws_frame(conn)
            if payload is None:
                break
            try:
                msg = json.loads(payload)
                mtype = msg.get("type")
                if mtype == "move":
                    INPUT_HANDLER.move_cursor(msg.get("dx", 0), msg.get("dy", 0))
                elif mtype == "click":
                    INPUT_HANDLER.mouse_click(msg.get("button", "left"), msg.get("action", "click"))
                elif mtype == "scroll":
                    INPUT_HANDLER.scroll(msg.get("dx", 0), msg.get("dy", 0))
                elif mtype == "app_switch":
                    INPUT_HANDLER.app_switch(msg.get("direction", "next"))
                elif mtype == "type_text":
                    INPUT_HANDLER.type_text(msg.get("text", ""))
                elif mtype == "key_combo":
                    INPUT_HANDLER.key_combo(msg.get("keys", []))
                elif mtype == "dictation_start":
                    DICTATION.on_text = lambda t: send_ws_frame(
                        conn, json.dumps({"type": "dictation_text", "text": t})
                    )
                    ok = DICTATION.start()
                    send_ws_frame(conn, json.dumps({"type": "dictation_ready", "ok": ok}))
                elif mtype == "dictation_audio":
                    DICTATION.audio(base64.b64decode(msg.get("data", "")))
                elif mtype == "dictation_stop":
                    DICTATION.stop()
                    send_ws_frame(conn, json.dumps({"type": "dictation_stopped"}))
                elif mtype == "ping":
                    pong = {"type": "pong", "timestamp": msg.get("timestamp", time.time() * 1000)}
                    send_ws_frame(conn, json.dumps(pong))
            except Exception as e:
                pass
    except Exception as e:
        pass
    finally:
        DICTATION.stop()
        try:
            conn.close()
        except Exception:
            pass

# The dictation transcript is pushed from a reader thread while the handler
# thread may still be answering pings, so writes serialise through one lock.
_WS_SEND_LOCK = threading.Lock()


def send_ws_frame(conn, message):
    data = message.encode('utf-8')
    length = len(data)
    header = bytearray([0x81]) # FIN + text opcode
    if length <= 125:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    with _WS_SEND_LOCK:
        conn.sendall(header + data)

def read_ws_frame(conn):
    try:
        header = conn.recv(2)
        if len(header) < 2:
            return None
        byte1, byte2 = header[0], header[1]
        masked = (byte2 & 0x80) != 0
        payload_len = byte2 & 0x7F
        if payload_len == 126:
            ext = conn.recv(2)
            payload_len = struct.unpack("!H", ext)[0]
        elif payload_len == 127:
            ext = conn.recv(8)
            payload_len = struct.unpack("!Q", ext)[0]

        mask = conn.recv(4) if masked else None
        data = bytearray()
        while len(data) < payload_len:
            chunk = conn.recv(min(payload_len - len(data), 4096))
            if not chunk:
                return None
            data.extend(chunk)

        if masked:
            data = bytes([b ^ mask[i % 4] for i, b in enumerate(data)])
        return data.decode('utf-8', errors='ignore')
    except Exception:
        return None

def run_ws_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", PORT))
    server.listen(10)
    print(f"[TailDeck] Daemon listening on 0.0.0.0:{PORT} (Tailscale IP compatible)")
    print(f"[TailDeck] Session: {SESSION_TYPE.upper()} | Backend: {BACKEND_NAME}")
    print("[TailDeck] Ready for Android remote trackpad connection!")
    print(f"[TailDeck] Web app root: {WEBROOT} "
          f"({'found' if os.path.isfile(os.path.join(WEBROOT, 'index.html')) else 'not published'})")
    for ip in local_ipv4_addresses():
        print(f"[TailDeck] Same-hotspot URL: http://{ip}:{PORT}/")
    while True:
        conn, addr = server.accept()
        t = threading.Thread(target=handle_websocket, args=(conn,), daemon=True)
        t.start()

if __name__ == "__main__":
    try:
        run_ws_server()
    except KeyboardInterrupt:
        print("\n[TailDeck] Daemon stopped.")
