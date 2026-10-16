#!/usr/bin/env python3
"""
TailDeck Linux Remote Daemon
Supports Wayland & X11 input injection via /dev/uinput, ydotool, xdotool, or evdev.
Zero external dependencies required (uses Python standard library for WebSocket & HTTP).
"""

import sys
import os
import io
import json
import time
import socket
import ssl
import struct
import tarfile
import urllib.parse
import urllib.request
import hashlib
import hmac
import base64
import threading
import subprocess
import tempfile
import pwd
from http.server import HTTPServer, BaseHTTPRequestHandler

DAEMON_VERSION = "1.4.0"

PORT = int(os.environ.get("TAILDECK_PORT", 8080))
DICTATE_HOST = os.environ.get("TAILDECK_DICTATE_HOST", "127.0.0.1")
DICTATE_PORT = int(os.environ.get("TAILDECK_DICTATE_PORT", 8090))

# Every client that reaches the daemon gets a durable line here plus a desktop
# notification on the laptop, whether it arrived on the hotspot or over
# Tailscale. The phone already notifies itself on connect; this is the laptop's
# own record of who reached it and by which route.
CONNECTION_LOG = os.environ.get(
    "TAILDECK_CONN_LOG",
    os.path.join(os.path.expanduser("~"), ".local", "state", "taildeck", "connections.log"),
)
NOTIFY_CONNECTIONS = os.environ.get("TAILDECK_NOTIFY", "1").lower() not in ("0", "false", "no")

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
        self._sent_frames = 0
        # The websocket connection that started the session. Only it may feed
        # or end it; a stray HTTP request or another tab closing must not cut
        # someone off mid-sentence.
        self.owner = None

    def start(self, owner=None):
        self._reset()
        self._sent_frames = 0
        try:
            sock = socket.create_connection((DICTATE_HOST, DICTATE_PORT), timeout=10)
            sock.settimeout(30)
            print(f"[TailDeck] {_ts()} bridge -> OP_START", flush=True)
            sock.sendall(bytes([OP_START]))
            if sock.recv(1) != bytes([OP_OK]):
                sock.close()
                return False
            self.sock = sock
            self.owner = owner
            print(f"[TailDeck] {_ts()} bridge <- OP_OK", flush=True)
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

    def audio(self, pcm, conn=None):
        if not self.sock or not pcm:
            return
        if conn is not None and self.owner is not None and self.owner is not conn:
            return
        try:
            with self.lock:
                if self._sent_frames == 0:
                    print(f"[TailDeck] {_ts()} bridge -> first OP_PCM", flush=True)
                self._sent_frames += 1
                self.sock.sendall(bytes([OP_PCM]) + struct.pack("!I", len(pcm)) + pcm)
        except Exception as e:
            print(f"[TailDeck] {_ts()} dictation audio dropped: {e}", flush=True)
            self._reset()

    def stop(self, conn=None):
        """End the session but keep the socket alive for the trailing text.

        A connection that does not own the session is ignored, so serving a
        page asset (or another client disconnecting) cannot silence a phone
        that is mid-dictation.
        """
        if conn is not None and self.owner is not None and self.owner is not conn:
            return
        self.owner = None
        if not self.sock:
            return
        try:
            print(f"[TailDeck] {_ts()} bridge -> OP_STOP after {self._sent_frames} PCM frames", flush=True)
            self.sock.sendall(bytes([OP_STOP]))
        except Exception:
            self._reset()

    def _reset(self):
        self.sock = None
        self.owner = None


def _ts():
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


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
                    e.KEY_LEFTMETA, e.KEY_VOLUMEUP, e.KEY_VOLUMEDOWN, e.KEY_MUTE,
                    # A uinput device can only emit keys it declared, so typing
                    # needs the full letter/digit/symbol set up front.
                    *[getattr(e, "KEY_" + chr(ord("A") + i)) for i in range(26)],
                    *[getattr(e, "KEY_" + str(i)) for i in range(10)],
                    *[getattr(e, "KEY_" + n) for n in (
                        "MINUS", "EQUAL", "LEFTBRACE", "RIGHTBRACE", "BACKSLASH",
                        "SEMICOLON", "APOSTROPHE", "GRAVE", "COMMA", "DOT", "SLASH",
                        "DELETE", "INSERT", "CAPSLOCK", "LEFT", "RIGHT", "UP", "DOWN",
                        "HOME", "END", "PAGEUP", "PAGEDOWN",
                    )],
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
            self._ensure_ydotool_socket()
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

    @staticmethod
    def _ensure_ydotool_socket():
        # ydotoold usually creates its socket under XDG_RUNTIME_DIR, while the
        # ydotool client falls back to /tmp/.ydotool_socket. When the two
        # disagree every input command silently no-ops, so point the client at
        # whichever socket actually exists.
        if os.environ.get("YDOTOOL_SOCKET"):
            return
        candidates = []
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if runtime_dir:
            candidates.append(os.path.join(runtime_dir, ".ydotool_socket"))
        candidates.append("/tmp/.ydotool_socket")
        candidates.append(f"/run/user/{os.getuid()}/.ydotool_socket")
        for path in candidates:
            if os.path.exists(path):
                os.environ["YDOTOOL_SOCKET"] = path
                return

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
            # Wheel moves require both axes on the option form; `-w -x` alone is
            # rejected, so use the positional `-- <xpos> <ypos>` shape.
            if dx or dy:
                subprocess.run(
                    ["ydotool", "mousemove", "-w", "--", str(int(dx)), str(int(dy))],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
        elif self.backend == "xdotool":
            btn = "4" if dy > 0 else "5"
            subprocess.run(["xdotool", "click", btn], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "pyautogui":
            import pyautogui
            pyautogui.scroll(int(dy * 10))

    def release_all(self):
        """Drop every button and modifier this virtual device may still hold.
        A client that vanishes between a `down` and its `up` (a drag, or a
        middle-button hold) would otherwise leave the desktop stuck pressed —
        Chrome autoscroll and runaway selection both start that way."""
        try:
            if self.backend == "evdev_uinput":
                from evdev import ecodes as e
                held = (
                    e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE,
                    e.KEY_LEFTCTRL, e.KEY_RIGHTCTRL,
                    e.KEY_LEFTALT, e.KEY_RIGHTALT,
                    e.KEY_LEFTSHIFT, e.KEY_RIGHTSHIFT,
                    e.KEY_LEFTMETA, e.KEY_RIGHTMETA,
                )
                for code in held:
                    self.ui.write(e.EV_KEY, code, 0)
                self.ui.syn()
            elif self.backend == "xdotool":
                for btn in ("1", "2", "3"):
                    subprocess.run(["xdotool", "mouseup", btn],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for mod in ("ctrl", "alt", "shift", "super"):
                    subprocess.run(["xdotool", "keyup", mod],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

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

    # US-layout mapping: character -> (ecodes name, needs_shift)
    TYPE_KEY_NAMES = {
        " ": ("KEY_SPACE", False), "\n": ("KEY_ENTER", False),
        "\t": ("KEY_TAB", False), "\b": ("KEY_BACKSPACE", False),
        "`": ("KEY_GRAVE", False), "~": ("KEY_GRAVE", True),
        "-": ("KEY_MINUS", False), "_": ("KEY_MINUS", True),
        "=": ("KEY_EQUAL", False), "+": ("KEY_EQUAL", True),
        "[": ("KEY_LEFTBRACE", False), "{": ("KEY_LEFTBRACE", True),
        "]": ("KEY_RIGHTBRACE", False), "}": ("KEY_RIGHTBRACE", True),
        "\\": ("KEY_BACKSLASH", False), "|": ("KEY_BACKSLASH", True),
        ";": ("KEY_SEMICOLON", False), ":": ("KEY_SEMICOLON", True),
        "'": ("KEY_APOSTROPHE", False), '"': ("KEY_APOSTROPHE", True),
        ",": ("KEY_COMMA", False), "<": ("KEY_COMMA", True),
        ".": ("KEY_DOT", False), ">": ("KEY_DOT", True),
        "/": ("KEY_SLASH", False), "?": ("KEY_SLASH", True),
        "!": ("KEY_1", True), "@": ("KEY_2", True), "#": ("KEY_3", True),
        "$": ("KEY_4", True), "%": ("KEY_5", True), "^": ("KEY_6", True),
        "&": ("KEY_7", True), "*": ("KEY_8", True), "(": ("KEY_9", True),
        ")": ("KEY_0", True),
    }

    def _key_spec(self, ch):
        spec = self.TYPE_KEY_NAMES.get(ch)
        if spec:
            return spec
        if "a" <= ch <= "z":
            return ("KEY_" + ch.upper(), False)
        if "A" <= ch <= "Z":
            return ("KEY_" + ch, True)
        if "0" <= ch <= "9":
            return ("KEY_" + ch, False)
        return None

    def can_type(self, text: str):
        return all(self._key_spec(c) for c in text)

    def _type_char_uinput(self, ch):
        from evdev import ecodes as e
        spec = self._key_spec(ch)
        if not spec:
            return False
        name, shift = spec
        code = getattr(e, name, None)
        if code is None:
            return False
        if shift:
            self.ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 1)
        self.ui.write(e.EV_KEY, code, 1)
        self.ui.syn()
        self.ui.write(e.EV_KEY, code, 0)
        self.ui.syn()
        if shift:
            self.ui.write(e.EV_KEY, e.KEY_LEFTSHIFT, 0)
            self.ui.syn()
        return True

    def type_text(self, text: str):
        """Types string input (e.g. from dictation or the live keyboard)."""
        # Native kernel injection first: real key events, no clipboard churn.
        # Matters most for live per-keystroke typing, where a clipboard paste
        # would clobber the user's clipboard on every character.
        if self.backend == "evdev_uinput" and self.can_type(text):
            for ch in text:
                self._type_char_uinput(ch)
            return

        # Try clipboard paste first for fast, exact unicode insertion
        if SESSION_TYPE == "wayland" and self._command_exists("wl-copy"):
            try:
                p = subprocess.Popen(["wl-copy"], stdin=subprocess.PIPE)
                p.communicate(input=text.encode('utf-8'))
                # Give the clipboard owner a moment to take the selection
                # before pasting, otherwise Ctrl+V can race and paste nothing.
                time.sleep(0.06)
                # Simulate Ctrl+V / Shift+Insert
                self.key_combo(["ctrl", "v"])
                return
            except Exception:
                pass
        elif SESSION_TYPE == "x11" and self._command_exists("xclip"):
            try:
                p = subprocess.Popen(["xclip", "-selection", "clipboard"], stdin=subprocess.PIPE)
                p.communicate(input=text.encode('utf-8'))
                time.sleep(0.06)
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

    def media_control(self, action: str):
        """Transport/volume keys, mapped per backend. The phone's media row
        drives whatever player the laptop is focused on."""
        spec = MEDIA_KEYS.get(action)
        if not spec:
            return
        if self.backend == "evdev_uinput":
            try:
                from evdev import ecodes as e
                code = getattr(e, spec["evdev"], None)
                if code is None:
                    return
                self.ui.write(e.EV_KEY, code, 1)
                self.ui.syn()
                self.ui.write(e.EV_KEY, code, 0)
                self.ui.syn()
            except Exception:
                pass
        elif self.backend == "xdotool":
            subprocess.run(["xdotool", "key", spec["xdotool"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif self.backend == "ydotool":
            # ydotool takes raw evdev keycodes; press then release.
            code = spec["code"]
            subprocess.run(
                ["ydotool", "key", f"{code}:1", f"{code}:0"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        elif self.backend == "pyautogui":
            try:
                import pyautogui
                pyautogui.press(spec["pyautogui"])
            except Exception:
                pass


# action -> per-backend key names / evdev codes for the media row.
MEDIA_KEYS = {
    "playpause": {"evdev": "KEY_PLAYPAUSE", "xdotool": "XF86AudioPlay", "pyautogui": "playpause", "code": 164},
    "next": {"evdev": "KEY_NEXTSONG", "xdotool": "XF86AudioNext", "pyautogui": "nexttrack", "code": 163},
    "prev": {"evdev": "KEY_PREVIOUSSONG", "xdotool": "XF86AudioPrev", "pyautogui": "prevtrack", "code": 165},
    "stop": {"evdev": "KEY_STOPCD", "xdotool": "XF86AudioStop", "pyautogui": "stop", "code": 166},
    "volup": {"evdev": "KEY_VOLUMEUP", "xdotool": "XF86AudioRaiseVolume", "pyautogui": "volumeup", "code": 115},
    "voldown": {"evdev": "KEY_VOLUMEDOWN", "xdotool": "XF86AudioLowerVolume", "pyautogui": "volumedown", "code": 114},
    "mute": {"evdev": "KEY_MUTE", "xdotool": "XF86AudioMute", "pyautogui": "volumemute", "code": 113},
}


INPUT_HANDLER = LinuxInputBackend()

# --- STANDALONE RFC6455 WEBSOCKET IMPLEMENTATION (No pip required) ---

# The same port answers plain GETs with the built app, so on a hotspot the
# phone can load it from the laptop itself and talk to it over ws:// with no
# Tailscale, no cellular data and no internet round trip. Set TAILDECK_WEBROOT
# to the directory holding the built index.html to enable it.
WEBROOT = os.environ.get("TAILDECK_WEBROOT", os.path.expanduser("~/taildeck-web"))

# Where new releases are published. The phone reads version.json from here to
# learn that a newer build exists; the daemon pulls the same manifest, the
# daemon script and the app tarball from here to update itself. Override for a
# fork or a mirror.
RELEASE_URL = os.environ.get(
    "TAILDECK_RELEASE_URL", "https://phy6.github.io/android-to-linux-remote"
).rstrip("/")
RELEASE_CACHE_TTL = int(os.environ.get("TAILDECK_RELEASE_TTL", 300))
RELEASE_CACHE = {"at": 0.0, "data": None}
RELEASE_LOCK = threading.Lock()

# The systemd --user unit a self-update restarts.
SERVICE_NAME = os.environ.get("TAILDECK_SERVICE", "taildeck.service")

# Hotspot TLS. http:// on a LAN address is not a secure context, so the phone
# would refuse to hand over its microphone over the direct route. Serving the
# same app over https fixes that. The certificate is self-signed, so the phone
# shows one warning to tap through. See scripts/make-cert.sh.
TLS_PORT = int(os.environ.get("TAILDECK_TLS_PORT", 8443))
TLS_DIR = os.environ.get("TAILDECK_TLS_DIR", os.path.expanduser("~/.config/taildeck/tls"))
TLS_CERT = os.path.join(TLS_DIR, "taildeck.crt")
TLS_KEY = os.path.join(TLS_DIR, "taildeck.key")
# Public half of the local CA, if one was generated. Guests install this once so
# an iPhone will accept the wss:// socket; see scripts/make-cert.sh.
TLS_CA = os.path.join(TLS_DIR, "ca.crt")

# A plain folder of text files that the phone can read as dictation scripts.
# The laptop owns the files; the phone lists and loads them over the same
# HTTP(S) port it already talks to, so scripts work on the hotspot with no
# internet and on Tailscale with no extra setup. Only .txt/.md files are served,
# and a save is written back here.
SCRIPTS_DIR = os.environ.get(
    "TAILDECK_SCRIPTS_DIR", os.path.join(os.path.expanduser("~"), "taildeck-scripts")
)
SCRIPT_EXT = (".txt", ".md", ".markdown")

# WebAuthn unlock material (phase 1: registration + assertion verification, no
# PAM yet). The phone registers a biometric-gated passkey; only its public half
# is stored here, and assertions are verified with the openssl CLI so the daemon
# keeps its zero-dependency promise.
AUTH_DIR = os.environ.get("TAILDECK_AUTH_DIR", os.path.expanduser("~/.config/taildeck/auth"))
AUTH_CRED_FILE = os.path.join(AUTH_DIR, "credentials.json")
# The relying party must be a real domain (WebAuthn rejects IP literals), so the
# tailnet name is the natural default. Both can be overridden for testing.
AUTH_RPID_ENV = os.environ.get("TAILDECK_RPID", "")
AUTH_ORIGIN_ENV = os.environ.get("TAILDECK_ORIGIN", "")
AUTH_CHALLENGE_TTL = int(os.environ.get("TAILDECK_AUTH_TTL", 60))
AUTH_LOCK = threading.Lock()
AUTH_PENDING = {}
_AUTH_RPID_CACHE = {"value": None}

# Phase 2: a verified phone assertion leaves a short-lived, single-use "grant"
# that the root-owned PAM helper may spend to satisfy auth for that one user.
# The helper proves it is the helper with a shared secret the daemon reads from
# a 0600 user-owned file (its twin lives at /etc/taildeck/pam.key, 0400 root).
AUTH_GRANT_TTL = int(os.environ.get("TAILDECK_GRANT_TTL", 30))
PAM_KEY_ENV = os.environ.get("TAILDECK_PAM_KEY", "")
PAM_KEY_FILE = os.environ.get(
    "TAILDECK_PAM_KEY_FILE", os.path.expanduser("~/.config/taildeck/pam.key")
)
AUTH_GRANTS = {}

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
        # The app may be served from GitHub Pages while the daemon sits on the
        # laptop, so the scripts API is cross-origin. These are read-mostly text
        # endpoints with no credentials; a wildcard origin is deliberate.
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
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


# --- SCRIPTS / SNIPPETS API -------------------------------------------------
#
# A tiny read/write API over one folder of text files so the phone's dictation
# modal can list the laptop's scripts and load one into the teleprompter. The
# folder is the source of truth; the phone may also keep its own local copy.


def _json(conn, obj, status="200 OK"):
    _http(conn, status, "application/json; charset=utf-8", json.dumps(obj).encode("utf-8"))


def _safe_script_name(name):
    """One flat file name, no traversal, a text extension. Returns None if bad."""
    name = urllib.parse.unquote(name).strip()
    if not name or name.startswith(".") or "/" in name or "\\" in name:
        return None
    if not name.lower().endswith(SCRIPT_EXT):
        return None
    if len(name) > 96:
        return None
    for ch in name:
        if not (ch.isalnum() or ch in " ._-()"):
            return None
    return name


def _read_http_body(conn, raw, headers):
    try:
        length = int(headers.get("content-length", "0") or "0")
    except Exception:
        length = 0
    if length <= 0:
        return b""
    sep = raw.find(b"\r\n\r\n")
    body = raw[sep + 4:] if sep >= 0 else b""
    while len(body) < length:
        chunk = conn.recv(min(length - len(body), 65536))
        if not chunk:
            break
        body += chunk
    return body[:length]


def _list_scripts():
    items = []
    try:
        names = sorted(os.listdir(SCRIPTS_DIR))
    except Exception:
        names = []
    for name in names:
        if _safe_script_name(name) is None:
            continue
        full = os.path.join(SCRIPTS_DIR, name)
        try:
            st = os.stat(full)
        except Exception:
            continue
        if not os.path.isfile(full):
            continue
        items.append({"name": name, "size": st.st_size, "modified": int(st.st_mtime)})
    return items


# --- WebAuthn: registration storage and assertion verification ---------------

# P-256 SPKI header, so a COSE EC2 key can be handed to openssl as a public key
# without a DER writer. 27 bytes; append x (32) then y (32) to finish it.
_COSE_SPKI_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d03010703420004")


def _b64u_decode(text):
    text = (text or "").strip()
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _b64u_encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _cbor_decode(data, idx=0):
    """Just enough CBOR for a COSE key: ints, byte/text strings, arrays, maps."""
    ib = data[idx]
    idx += 1
    major = ib >> 5
    ai = ib & 0x1F
    if ai < 24:
        val = ai
    elif ai == 24:
        val = data[idx]
        idx += 1
    elif ai == 25:
        val = struct.unpack("!H", data[idx:idx + 2])[0]
        idx += 2
    elif ai == 26:
        val = struct.unpack("!I", data[idx:idx + 4])[0]
        idx += 4
    elif ai == 27:
        val = struct.unpack("!Q", data[idx:idx + 8])[0]
        idx += 8
    else:
        raise ValueError("indefinite-length CBOR not supported")
    if major == 0:
        return val, idx
    if major == 1:
        return -1 - val, idx
    if major == 2:
        return bytes(data[idx:idx + val]), idx + val
    if major == 3:
        return bytes(data[idx:idx + val]).decode("utf-8", "replace"), idx + val
    if major == 4:
        arr = []
        for _ in range(val):
            item, idx = _cbor_decode(data, idx)
            arr.append(item)
        return arr, idx
    if major == 5:
        out = {}
        for _ in range(val):
            k, idx = _cbor_decode(data, idx)
            v, idx = _cbor_decode(data, idx)
            out[k] = v
        return out, idx
    if major == 6:
        return _cbor_decode(data, idx)
    raise ValueError("unsupported CBOR major type")


def _cose_to_spki(cose_bytes):
    """COSE EC2/P-256 public key bytes -> DER SubjectPublicKeyInfo."""
    key, _ = _cbor_decode(cose_bytes, 0)
    if not isinstance(key, dict):
        raise ValueError("COSE key is not a map")
    if key.get(1) != 2 or key.get(-1) != 1:
        raise ValueError("only EC2/P-256 (ES256) is supported")
    x, y = key.get(-2), key.get(-3)
    if not isinstance(x, (bytes, bytearray)) or len(x) != 32:
        raise ValueError("bad x coordinate")
    if not isinstance(y, (bytes, bytearray)) or len(y) != 32:
        raise ValueError("bad y coordinate")
    return _COSE_SPKI_PREFIX + bytes(x) + bytes(y)


def _spki_pem(spki_der):
    b64 = base64.b64encode(spki_der).decode("ascii")
    body = "\n".join(b64[i:i + 64] for i in range(0, len(b64), 64))
    return f"-----BEGIN PUBLIC KEY-----\n{body}\n-----END PUBLIC KEY-----\n"


def _verify_es256(spki_der, message, signature_der):
    """True when signature_der is a valid ECDSA-SHA256 signature over message."""
    try:
        with tempfile.TemporaryDirectory() as d:
            pub = os.path.join(d, "pub.pem")
            msg = os.path.join(d, "msg.bin")
            sig = os.path.join(d, "sig.bin")
            with open(pub, "w", encoding="ascii") as fh:
                fh.write(_spki_pem(spki_der))
            with open(msg, "wb") as fh:
                fh.write(message)
            with open(sig, "wb") as fh:
                fh.write(signature_der)
            res = subprocess.run(
                ["openssl", "dgst", "-sha256", "-verify", pub, "-signature", sig, msg],
                capture_output=True, text=True,
            )
            return res.returncode == 0
    except Exception:
        return False


def auth_rpid():
    if AUTH_RPID_ENV:
        return AUTH_RPID_ENV
    if _AUTH_RPID_CACHE["value"] is None:
        _AUTH_RPID_CACHE["value"] = tailnet_dns_name() or ""
    return _AUTH_RPID_CACHE["value"]


def auth_origin():
    if AUTH_ORIGIN_ENV:
        return AUTH_ORIGIN_ENV
    rp = auth_rpid()
    return f"https://{rp}" if rp else ""


def _default_user():
    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        return os.environ.get("USER", "user")


def _load_credentials():
    try:
        with open(AUTH_CRED_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_credentials(items):
    try:
        os.makedirs(AUTH_DIR, exist_ok=True)
        tmp = AUTH_CRED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(items, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, AUTH_CRED_FILE)
        return True
    except Exception:
        return False


def _find_credential(credential_id, user=None):
    for cred in _load_credentials():
        if cred.get("id") != credential_id:
            continue
        if user and cred.get("user") not in (None, user):
            continue
        return cred
    return None


def _prune_pending():
    now = time.time()
    with AUTH_LOCK:
        stale = [
            rid for rid, rec in AUTH_PENDING.items()
            if now - rec["created"] > rec["ttl"] * 4
        ]
        for rid in stale:
            AUTH_PENDING.pop(rid, None)


def auth_begin(user=None, rp_id=None, origin=None):
    """Mint a challenge and push it to every connected phone. Returns the
    parameters the authenticator needs, or an error string.

    The relying party is whichever domain the app is served from, so the caller
    (or the registered credential) names it; the tailnet default is only a
    fallback. WebAuthn rejects IP-literal rpIds, so hotspot-served pages cannot
    register at all."""
    user = user or _default_user()
    if not rp_id:
        stored = [c for c in _load_credentials() if c.get("user") in (None, user) and c.get("rpId")]
        rp_id = stored[0]["rpId"] if stored else auth_rpid()
    if not rp_id:
        return None, "no relying-party domain (open the app from a real domain, not an IP)"
    origin = origin or (AUTH_ORIGIN_ENV or f"https://{rp_id}")
    _prune_pending()
    challenge = _b64u_encode(os.urandom(32))
    request_id = _b64u_encode(os.urandom(12))
    allow = [c["id"] for c in _load_credentials() if c.get("user") in (None, user)]
    rec = {
        "challenge": challenge,
        "user": user,
        "rpId": rp_id,
        "origin": origin,
        "created": time.time(),
        "ttl": AUTH_CHALLENGE_TTL,
        "status": "pending",
        "ok": False,
    }
    with AUTH_LOCK:
        AUTH_PENDING[request_id] = rec
    sent = broadcast_json({
        "type": "auth_challenge",
        "requestId": request_id,
        "challenge": challenge,
        "rpId": rp_id,
        "origin": origin,
        "allowCredentials": allow,
        "timeout": AUTH_CHALLENGE_TTL * 1000,
    })
    print(f"[TailDeck] auth_begin user={user} rpId={rp_id} pushed={sent}", flush=True)
    return {
        "requestId": request_id,
        "challenge": challenge,
        "rpId": rp_id,
        "origin": origin,
        "allowCredentials": allow,
        "timeoutMs": AUTH_CHALLENGE_TTL * 1000,
    }, None


def auth_verify(request_id, payload):
    """Verify a WebAuthn assertion against the pending challenge."""
    with AUTH_LOCK:
        rec = AUTH_PENDING.get(request_id)
        if rec is None:
            return False, "unknown request"
        if rec["status"] != "pending":
            return rec["ok"], rec["status"]
        if time.time() - rec["created"] > rec["ttl"]:
            rec["status"] = "expired"
            return False, "expired"

    credential_id = payload.get("credentialId")
    cred = _find_credential(credential_id, rec["user"])
    if cred is None:
        with AUTH_LOCK:
            rec["status"] = "failed:unknown-credential"
        return False, "unknown credential"

    reason = ""
    ok = False
    try:
        auth_data = _b64u_decode(payload.get("authenticatorData", ""))
        client_raw = _b64u_decode(payload.get("clientDataJSON", ""))
        signature = _b64u_decode(payload.get("signature", ""))
        client = json.loads(client_raw)
        if client.get("type") != "webauthn.get":
            reason = "clientData.type"
        elif client.get("challenge") != rec["challenge"]:
            reason = "challenge"
        elif rec["origin"] and client.get("origin") != rec["origin"]:
            reason = "origin"
        elif hashlib.sha256(rec["rpId"].encode("utf-8")).digest() != auth_data[:32]:
            reason = "rpIdHash"
        elif not (auth_data[32] & 0x01):
            reason = "user-presence"
        elif not (auth_data[32] & 0x04):
            reason = "user-verification"
        else:
            spki = _cose_to_spki(_b64u_decode(cred["publicKey"]))
            message = auth_data + hashlib.sha256(client_raw).digest()
            ok = _verify_es256(spki, message, signature)
            if not ok:
                reason = "signature"
    except Exception as e:
        reason = f"malformed:{e}"

    with AUTH_LOCK:
        rec["ok"] = ok
        rec["status"] = "verified" if ok else f"failed:{reason}"
        if ok:
            now = time.time()
            AUTH_GRANTS[rec["user"]] = {
                "nonce": request_id,
                "created": now,
                "expires": now + AUTH_GRANT_TTL,
            }
    print(f"[TailDeck] auth_verify {request_id} -> {rec['status']}", flush=True)
    return ok, rec["status"]


def auth_status(request_id):
    with AUTH_LOCK:
        rec = AUTH_PENDING.get(request_id)
        if rec is None:
            return None
        if rec["status"] == "pending" and time.time() - rec["created"] > rec["ttl"]:
            rec["status"] = "expired"
        return dict(rec)


def _pam_key():
    """The shared secret the PAM helper must present. Read once from the env or
    the 0600 key file; empty means phone-unlock is not configured."""
    if PAM_KEY_ENV:
        return PAM_KEY_ENV
    try:
        with open(PAM_KEY_FILE, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def _consume_grant(user, key):
    """Spend a verified grant for *user*. Single use, short TTL, secret-gated."""
    expected = _pam_key()
    if not expected:
        return False, "not configured"
    if not key or not hmac.compare_digest(str(key), expected):
        print("[TailDeck] pam consume rejected: bad key", flush=True)
        return False, "forbidden"
    now = time.time()
    with AUTH_LOCK:
        for u in list(AUTH_GRANTS):
            if AUTH_GRANTS[u]["expires"] < now:
                AUTH_GRANTS.pop(u, None)
        grant = AUTH_GRANTS.pop(user, None)
    if grant is None:
        print(f"[TailDeck] pam consume for {user}: no grant", flush=True)
        return False, "no grant"
    if grant["expires"] < now:
        print(f"[TailDeck] pam consume for {user}: expired", flush=True)
        return False, "expired"
    print(f"[TailDeck] pam consume for {user}: granted (nonce {grant['nonce']})", flush=True)
    return True, "ok"


def _peer_is_loopback(conn):
    try:
        addr = conn.getpeername()[0]
    except Exception:
        return False
    return addr in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


# --- Version checking and self-update --------------------------------------
#
# The phone and the laptop both report a version; the phone compares them with
# the published manifest and offers an update. Updating the *laptop* means
# pulling the newest daemon script and app tarball from RELEASE_URL, checking
# their checksums against the manifest, writing them into place and restarting
# the user service. No root is needed: the service is a --user unit.

def _http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": f"TailDeck/{DAEMON_VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def release_manifest(force=False, timeout=8):
    """The published version.json, cached briefly so a burst of checks is cheap."""
    now = time.time()
    with RELEASE_LOCK:
        fresh = RELEASE_CACHE["data"] and (now - RELEASE_CACHE["at"]) < RELEASE_CACHE_TTL
        if fresh and not force:
            return RELEASE_CACHE["data"]
    try:
        data = json.loads(_http_get(f"{RELEASE_URL}/version.json", timeout=timeout) or "{}")
    except Exception:
        return None
    with RELEASE_LOCK:
        RELEASE_CACHE.update(at=now, data=data)
    return data


def _in_git_worktree(path):
    d = os.path.dirname(os.path.abspath(path))
    while d and d != "/":
        if os.path.isdir(os.path.join(d, ".git")):
            return True
        d = os.path.dirname(d)
    return False


def managed_daemon_path():
    """Where a self-update should write the daemon, or None.

    install.sh puts it in ~/.local/bin and points the service there. A
    development checkout (a symlink into a git worktree) is never overwritten,
    so a self-update only refreshes the app for those boxes."""
    for p in (os.path.expanduser("~/.local/bin/taildeck-daemon.py"),
              os.path.expanduser("~/taildeck-daemon.py")):
        if not os.path.exists(p):
            continue
        real = os.path.realpath(p)
        if _in_git_worktree(real):
            return None
        return real
    return None


def _safe_extract_tar(blob, dest):
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
        for member in tf.getmembers():
            name = member.name
            if name.startswith("/") or ".." in name.split("/"):
                raise ValueError(f"unsafe path in bundle: {name}")
        tf.extractall(dest)


def _schedule_restart():
    """Restart the user service from outside it, so the restart survives us."""
    script = f"sleep 1; systemctl --user restart {SERVICE_NAME}"
    for argv in (["systemd-run", "--user", "--collect", "--unit", "taildeck-selfupdate",
                  "/bin/sh", "-c", script],):
        try:
            subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return "systemd-run"
        except FileNotFoundError:
            continue
    try:
        subprocess.Popen(["/bin/sh", "-c", script], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "detached"
    except Exception:
        return None


def _atomic_write(path, blob):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        os.chmod(tmp, 0o755)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def perform_update(dry_run=False):
    """Pull the latest release. Returns (ok, report)."""
    latest = release_manifest(force=True)
    if not latest:
        return False, {"error": f"could not reach the release channel ({RELEASE_URL})"}

    target_daemon = latest.get("daemon")
    target_app = latest.get("app")
    files = latest.get("files") or {}
    report = {
        "from": DAEMON_VERSION,
        "to": target_daemon,
        "app": target_app,
        "dryRun": bool(dry_run),
        "steps": [],
    }

    try:
        web_blob = _http_get(f"{RELEASE_URL}/taildeck-web.tar.gz", timeout=60)
    except Exception as e:
        return False, {"error": f"app download failed: {e}"}
    web_sha = hashlib.sha256(web_blob).hexdigest()
    if files.get("web") and files["web"] != web_sha:
        return False, {"error": "app bundle checksum mismatch", "expected": files["web"], "got": web_sha}
    report["steps"].append(f"app bundle {len(web_blob)} bytes sha256={web_sha[:12]}")

    daemon_blob = None
    daemon_path = managed_daemon_path()
    if daemon_path:
        try:
            daemon_blob = _http_get(f"{RELEASE_URL}/taildeck-daemon.py", timeout=30)
        except Exception as e:
            return False, {"error": f"daemon download failed: {e}"}
        daemon_sha = hashlib.sha256(daemon_blob).hexdigest()
        if files.get("daemon") and files["daemon"] != daemon_sha:
            return False, {"error": "daemon checksum mismatch", "expected": files["daemon"], "got": daemon_sha}
        report["steps"].append(f"daemon -> {daemon_path} {len(daemon_blob)} bytes")
    else:
        report["steps"].append("daemon skipped (managed locally; app updated only)")

    if dry_run:
        report["ok"] = True
        return True, report

    try:
        _safe_extract_tar(web_blob, WEBROOT)
        report["steps"].append(f"app written to {WEBROOT}")
    except Exception as e:
        return False, {"error": f"could not write the app: {e}"}

    if daemon_path and daemon_blob is not None:
        try:
            _atomic_write(daemon_path, daemon_blob)
            report["steps"].append("daemon written")
        except Exception as e:
            return False, {"error": f"could not write the daemon: {e}"}
        report["restart"] = _schedule_restart()
        if not report["restart"]:
            report["steps"].append("restart the service by hand: systemctl --user restart taildeck")

    report["ok"] = True
    print(f"[TailDeck] self-update: {report}", flush=True)
    return True, report


def handle_api(conn, raw, request_line):
    """Answer /api/* and the CA download. Returns True when it handled the
    request, so the caller does not fall through to static file serving."""
    try:
        parts = request_line.split()
        method = parts[0].upper()
        target = parts[1]
    except Exception:
        return False
    path = target.split("?", 1)[0]

    if path in ("/taildeck-ca.crt", "/ca.crt"):
        if os.path.isfile(TLS_CA):
            try:
                with open(TLS_CA, "rb") as fh:
                    _http(conn, "200 OK", "application/x-x509-ca-cert", fh.read())
            except Exception:
                _http(conn, "500 Internal Server Error", "text/plain; charset=utf-8", b"Unreadable\n")
        else:
            _http(conn, "404 Not Found", "text/plain; charset=utf-8",
                  b"TailDeck: no CA here; the certificate is self-signed.\n")
        return True

    if not path.startswith("/api/"):
        return False

    if method == "OPTIONS":
        _http(conn, "204 No Content", "text/plain; charset=utf-8", b"")
        return True

    headers = _parse_headers(raw.decode("utf-8", errors="ignore"))

    if path == "/api/scripts" and method == "GET":
        _json(conn, {"ok": True, "dir": SCRIPTS_DIR, "scripts": _list_scripts()})
        return True

    if path.startswith("/api/scripts/"):
        name = _safe_script_name(path[len("/api/scripts/"):])
        if name is None:
            _json(conn, {"ok": False, "error": "bad name"}, "400 Bad Request")
            return True
        full = os.path.join(SCRIPTS_DIR, name)

        if method == "GET":
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except FileNotFoundError:
                _json(conn, {"ok": False, "error": "not found"}, "404 Not Found")
                return True
            except Exception:
                _json(conn, {"ok": False, "error": "unreadable"}, "500 Internal Server Error")
                return True
            _json(conn, {"ok": True, "name": name, "text": text})
            return True

        if method in ("POST", "PUT"):
            body = _read_http_body(conn, raw, headers)
            text = body.decode("utf-8", errors="replace")
            if len(text.encode("utf-8")) > 256 * 1024:
                _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
                return True
            try:
                os.makedirs(SCRIPTS_DIR, exist_ok=True)
                with open(full, "w", encoding="utf-8") as fh:
                    fh.write(text)
            except Exception:
                _json(conn, {"ok": False, "error": "unwritable"}, "500 Internal Server Error")
                return True
            print(f"[TailDeck] script saved: {name} ({len(text)} bytes)", flush=True)
            _json(conn, {"ok": True, "name": name})
            return True

    if path == "/api/notify" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        title = str(data.get("title") or "TailDeck")
        text = str(data.get("body") or data.get("message") or "")
        if not text:
            _json(conn, {"ok": False, "error": "empty"}, "400 Bad Request")
            return True
        sent = broadcast_notify(title, text)
        print(f"[TailDeck] notify -> {sent} phone(s): {text[:60]}", flush=True)
        _json(conn, {"ok": True, "sent": sent})
        return True

    if path == "/api/auth/info" and method == "GET":
        creds = _load_credentials()
        _json(conn, {
            "ok": True,
            "configured": bool(auth_rpid()),
            "rpId": auth_rpid(),
            "origin": auth_origin(),
            "user": _default_user(),
            "credentials": [
                {"id": c.get("id"), "label": c.get("label"), "created": c.get("created")}
                for c in creds
            ],
        })
        return True

    if path == "/api/webauthn/register" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        cred_id = str(data.get("credentialId") or "").strip()
        cose_b64 = str(data.get("publicKey") or "").strip()
        if not cred_id or not cose_b64:
            _json(conn, {"ok": False, "error": "credentialId and publicKey required"}, "400 Bad Request")
            return True
        try:
            _cose_to_spki(_b64u_decode(cose_b64))
        except Exception as e:
            _json(conn, {"ok": False, "error": f"bad public key: {e}"}, "400 Bad Request")
            return True
        creds = [c for c in _load_credentials() if c.get("id") != cred_id]
        creds.append({
            "id": cred_id,
            "publicKey": cose_b64,
            "label": str(data.get("label") or "phone")[:64],
            "user": str(data.get("user") or _default_user()),
            "rpId": str(data.get("rpId") or auth_rpid())[:128],
            "created": int(time.time()),
        })
        if not _save_credentials(creds):
            _json(conn, {"ok": False, "error": "could not store"}, "500 Internal Server Error")
            return True
        print(f"[TailDeck] passkey registered: {cred_id} for {creds[-1]['user']}", flush=True)
        _json(conn, {"ok": True, "count": len(creds)})
        return True

    if path == "/api/webauthn/credentials" and method == "GET":
        _json(conn, {"ok": True, "credentials": [
            {"id": c.get("id"), "label": c.get("label"), "user": c.get("user"), "created": c.get("created")}
            for c in _load_credentials()
        ]})
        return True

    if path.startswith("/api/webauthn/credentials/") and method == "DELETE":
        cred_id = urllib.parse.unquote(path[len("/api/webauthn/credentials/"):]).strip()
        creds = _load_credentials()
        remaining = [c for c in creds if c.get("id") != cred_id]
        if len(remaining) == len(creds):
            _json(conn, {"ok": False, "error": "not found"}, "404 Not Found")
            return True
        _save_credentials(remaining)
        _json(conn, {"ok": True, "count": len(remaining)})
        return True

    if path == "/api/auth/begin" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        info, err = auth_begin(data.get("user"), data.get("rpId"), data.get("origin"))
        if err:
            _json(conn, {"ok": False, "error": err}, "409 Conflict")
            return True
        _json(conn, {"ok": True, **info})
        return True

    if path == "/api/auth/response" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        request_id = str(data.get("requestId") or "")
        ok, status = auth_verify(request_id, data)
        _json(conn, {"ok": ok, "status": status})
        return True

    if path == "/api/auth/status" and method == "GET":
        query = urllib.parse.parse_qs(target.split("?", 1)[1]) if "?" in target else {}
        request_id = (query.get("requestId") or [""])[0]
        rec = auth_status(request_id)
        if rec is None:
            _json(conn, {"ok": False, "error": "unknown request"}, "404 Not Found")
            return True
        _json(conn, {"ok": rec["status"] == "verified", "status": rec["status"], "user": rec["user"]})
        return True

    if path == "/api/auth/consume" and method in ("POST", "PUT"):
        # Called by the root-owned PAM helper during the auth phase. Gated by a
        # shared secret and by the connection arriving on the loopback socket.
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        user = str(data.get("user") or "")
        key = headers.get("x-taildeck-pam-key", "")
        if not _peer_is_loopback(conn):
            _json(conn, {"ok": False, "status": "not local"}, "403 Forbidden")
            return True
        if not user:
            _json(conn, {"ok": False, "status": "no user"}, "400 Bad Request")
            return True
        ok, status = _consume_grant(user, key)
        _json(conn, {"ok": ok, "status": status}, "200 OK" if ok else "403 Forbidden")
        return True

    if path == "/api/version" and method == "GET":
        latest = release_manifest()
        _json(conn, {
            "ok": True,
            "daemon": DAEMON_VERSION,
            "backend": BACKEND_NAME,
            "release": RELEASE_URL,
            "webroot": WEBROOT,
            "managed": managed_daemon_path() is not None,
            "latest": (latest or {}).get("daemon"),
            "latestApp": (latest or {}).get("app"),
            "updateAvailable": bool(latest and latest.get("daemon") and latest["daemon"] != DAEMON_VERSION),
        })
        return True

    if path == "/api/update" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}

        # A passkey, once registered, is the gate: the update must be preceded by
        # a verified assertion. Before any passkey exists, an explicit confirm
        # from the app is enough so the first update is still possible.
        creds = _load_credentials()
        if creds:
            request_id = str(data.get("requestId") or "")
            rec = auth_status(request_id)
            if rec is None or rec.get("status") != "verified":
                _json(conn, {"ok": False, "error": "unlock with your phone to update",
                             "status": (rec or {}).get("status", "unknown")}, "403 Forbidden")
                return True
            with AUTH_LOCK:
                AUTH_PENDING.pop(request_id, None)  # single use
        elif not data.get("confirm"):
            _json(conn, {"ok": False, "error": "confirmation required"}, "400 Bad Request")
            return True

        ok, report = perform_update(dry_run=bool(data.get("dryRun")))
        _json(conn, {"ok": ok, **report}, "200 OK" if ok else "502 Bad Gateway")
        return True

    _json(conn, {"ok": False, "error": "unknown endpoint"}, "404 Not Found")
    return True


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


def tailnet_dns_name():
    """MagicDNS name of this machine, if the Tailscale CLI can tell us.

    The tailnet suffix is per-account and cannot be derived from the hostname,
    so ask tailscale itself. A missing CLI or a logged-out node simply means we
    report no tailnet name rather than inventing one.
    """
    try:
        res = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=3,
        )
        if res.returncode == 0 and res.stdout:
            self_info = (json.loads(res.stdout) or {}).get("Self") or {}
            name = str(self_info.get("DNSName") or "").rstrip(".")
            if name:
                return name
    except Exception:
        pass
    return None


def _parse_headers(raw):
    """Lower-cased header map from a raw HTTP request head. Enough to read the
    X-Forwarded-* pair a reverse proxy adds."""
    headers = {}
    for line in raw.split("\r\n")[1:]:
        if not line or ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return headers


def _classify_route(host):
    """Tailscale hands out CGNAT addresses (100.64.0.0/10); the hotspot is the
    ordinary private ranges. Naming the route is the point of the record."""
    try:
        first, second = (int(part) for part in host.split(".")[:2])
    except Exception:
        return "unknown"
    if first == 100 and 64 <= second <= 127:
        return "Tailscale"
    if first == 127:
        return "local"
    if first == 10 or (first == 192 and second == 168) or (first == 172 and 16 <= second <= 31):
        return "hotspot"
    return "network"


def notify_desktop(summary, body):
    """Best-effort laptop notification; a headless or DBus-less run just skips."""
    try:
        subprocess.Popen(
            ["notify-send", "-a", "TailDeck", summary, body],
            env=os.environ.copy(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def record_connection(event, peer, scheme, route, extra=""):
    """Append one line to the connection log and, on arrival, notify the laptop.
    Logging and notify-send must never be able to break a session."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"{stamp} {event:<9} {peer} {route} {scheme}"
    if extra:
        line += f" {extra}"
    try:
        os.makedirs(os.path.dirname(CONNECTION_LOG), exist_ok=True)
        with open(CONNECTION_LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
    print(f"[TailDeck] {line}", flush=True)
    if event == "connected" and NOTIFY_CONNECTIONS:
        notify_desktop("TailDeck", f"{peer} connected via {route}")


# Connected phone sessions, so the laptop can push a notice to all of them at
# once. Delivery is best-effort: the phone only sees it while its page is alive.
WS_CLIENTS = set()
_WS_CLIENTS_LOCK = threading.Lock()


def broadcast_json(obj):
    """Send one JSON message to every connected phone. Returns how many got it."""
    payload = json.dumps(obj)
    with _WS_CLIENTS_LOCK:
        clients = list(WS_CLIENTS)
    sent = 0
    for client in clients:
        try:
            send_ws_frame(client, payload)
            sent += 1
        except Exception:
            with _WS_CLIENTS_LOCK:
                WS_CLIENTS.discard(client)
    return sent


def broadcast_notify(title, body):
    """Send a notice to every connected phone. Returns how many got it."""
    return broadcast_json({"type": "notify", "title": title, "body": body})


def handle_websocket(conn):
    try:
        peer = "{}:{}".format(*conn.getpeername()[:2])
    except Exception:
        peer = "?"
    try:
        local_port = conn.getsockname()[1]
    except Exception:
        local_port = PORT
    started = time.time()
    scheme = "https" if local_port == TLS_PORT else "http"
    route = _classify_route(peer.split(":")[0])
    logged_peer = peer
    proxied = False
    is_ws = False
    try:
        raw = conn.recv(4096)
        data = raw.decode('utf-8', errors='ignore')
        if "Upgrade: websocket" not in data:
            request_line = data.split("\r\n", 1)[0] if data else "GET / HTTP/1.1"
            if handle_api(conn, raw, request_line):
                conn.close()
                return
            serve_static(conn, request_line)
            conn.close()
            return
        is_ws = True

        # Behind a reverse proxy (tailscale serve) the socket peer is always
        # 127.0.0.1, so prefer the real client the edge reported in
        # X-Forwarded-For. That keeps a proxied session labelled with the
        # phone's own address and route instead of a meaningless loopback line.
        headers = _parse_headers(data)
        forwarded_for = headers.get("x-forwarded-for", "")
        forwarded_proto = headers.get("x-forwarded-proto", "")
        proxied = bool(forwarded_for)
        if forwarded_for:
            logged_peer = forwarded_for.split(",")[0].strip()
            route = _classify_route(logged_peer)
        if forwarded_proto in ("http", "https"):
            scheme = forwarded_proto

        print(
            f"[TailDeck] ws open {peer}"
            f"{' proxy -> ' + logged_peer if proxied else ''}",
            flush=True,
        )
        record_connection("connected", logged_peer, scheme, route, "via=serve" if proxied else "")

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
            "backend": BACKEND_NAME,
            # How the phone can reach this laptop next time. The LAN addresses
            # only work on the same hotspot; the tailnet name works anywhere.
            "addresses": local_ipv4_addresses(),
            "tailnet": tailnet_dns_name(),
            "ports": {"http": PORT, "https": TLS_PORT},
        }
        send_ws_frame(conn, json.dumps(welcome))

        with _WS_CLIENTS_LOCK:
            WS_CLIENTS.add(conn)

        # Per-connection dictation accounting, so a silent session is easy to
        # tell apart from one that never carried any audio.
        dictation_bytes = 0

        # Main message processing loop
        while True:
            payload = read_ws_frame(conn)
            if payload is None:
                print(f"[TailDeck] ws closed {logged_peer} bytes={dictation_bytes}", flush=True)
                record_connection(
                    "closed",
                    logged_peer,
                    scheme,
                    route,
                    f"dur={int(time.time() - started)}s bytes={dictation_bytes}"
                    + (" via=serve" if proxied else ""),
                )
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
                elif mtype == "media":
                    INPUT_HANDLER.media_control(msg.get("action", ""))
                elif mtype == "auth_response":
                    auth_verify(msg.get("requestId", ""), msg)
                elif mtype == "type_text":
                    INPUT_HANDLER.type_text(msg.get("text", ""))
                elif mtype == "key_combo":
                    INPUT_HANDLER.key_combo(msg.get("keys", []))
                elif mtype == "dictation_start":
                    DICTATION.on_text = lambda t: send_ws_frame(
                        conn, json.dumps({"type": "dictation_text", "text": t})
                    )
                    ok = DICTATION.start(conn)
                    dictation_bytes = 0
                    print(f"[TailDeck] {peer} dictation_start ok={ok}", flush=True)
                    send_ws_frame(conn, json.dumps({"type": "dictation_ready", "ok": ok}))
                elif mtype == "dictation_audio":
                    pcm = base64.b64decode(msg.get("data", ""))
                    dictation_bytes += len(pcm)
                    DICTATION.audio(pcm, conn)
                elif mtype == "dictation_stop":
                    DICTATION.stop(conn)
                    print(f"[TailDeck] {peer} dictation_stop bytes={dictation_bytes}", flush=True)
                    send_ws_frame(conn, json.dumps({"type": "dictation_stopped"}))
                elif mtype == "ping":
                    pong = {"type": "pong", "timestamp": msg.get("timestamp", time.time() * 1000)}
                    send_ws_frame(conn, json.dumps(pong))
            except Exception as e:
                pass
    except Exception as e:
        pass
    finally:
        if is_ws:
            DICTATION.stop(conn)
            # Never let a half-finished drag or held key outlive its client.
            INPUT_HANDLER.release_all()
            with _WS_CLIENTS_LOCK:
                WS_CLIENTS.discard(conn)
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

def run_ws_server(port=PORT, tls_context=None):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", port))
    server.listen(10)

    if tls_context is not None:
        server = tls_context.wrap_socket(server, server_side=True)
        print(f"[TailDeck] Daemon listening on 0.0.0.0:{port} (https)")

    while True:
        try:
            conn, addr = server.accept()
        except ssl.SSLError as e:
            print(f"[TailDeck] TLS handshake failed: {e}")
            continue
        except OSError as e:
            # A client that connects and then vanishes (or resets mid-handshake)
            # surfaces here as ConnectionResetError. Catching only ssl.SSLError
            # used to let that kill this thread and take the whole https
            # listener down with it, which silently dropped the phone back to
            # plain http on 8080 (no secure context: no dictation).
            print(f"[TailDeck] accept() failed, staying up: {e}")
            continue
        t = threading.Thread(target=handle_websocket, args=(conn,), daemon=True)
        t.start()


def build_tls_context():
    """Load the self-signed certificate, or explain how to make one."""
    if not (os.path.isfile(TLS_CERT) and os.path.isfile(TLS_KEY)):
        print(f"[TailDeck] No certificate at {TLS_DIR} - hotspot mode stays http only")
        print("[TailDeck]   run scripts/make-cert.sh to enable https on the direct route")
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(TLS_CERT, TLS_KEY)
    return ctx


def _cli_notify(args):
    """`taildeck-daemon.py notify "text"` -- push a notice to the phone by
    talking to the already-running daemon over loopback, so it can ride the
    live WebSocket instead of opening a new connection."""
    text = " ".join(args).strip()
    if not text:
        print("usage: taildeck-daemon.py notify \"message\"", file=sys.stderr)
        return 2
    payload = json.dumps({"title": "TailDeck", "body": text}).encode("utf-8")
    head = (
        "POST /api/notify HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    # Either listener shares the same connected-phone set, so the first one
    # that answers is enough; trying both would double-send the notice.
    for port, scheme in ((TLS_PORT, "https"), (PORT, "http")):
        try:
            raw_conn = socket.create_connection(("127.0.0.1", port), timeout=3)
            if scheme == "https":
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                conn = ctx.wrap_socket(raw_conn, server_hostname="127.0.0.1")
            else:
                conn = raw_conn
            conn.sendall(head + payload)
            status = conn.recv(256).decode("utf-8", errors="ignore").split("\r\n", 1)[0]
            conn.close()
            if " 200 " in status:
                print(f"[TailDeck] notify sent: {text}")
                return 0
        except Exception:
            continue
    print("[TailDeck] notify: no running daemon answered", file=sys.stderr)
    return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "notify":
        sys.exit(_cli_notify(sys.argv[2:]))
    try:
        tls_context = build_tls_context()

        print(f"[TailDeck] Daemon listening on 0.0.0.0:{PORT} (Tailscale IP compatible)")
        print(f"[TailDeck] Session: {SESSION_TYPE.upper()} | Backend: {BACKEND_NAME}")
        print("[TailDeck] Ready for Android remote trackpad connection!")
        print(f"[TailDeck] Connection log: {CONNECTION_LOG} "
              f"(notify={'on' if NOTIFY_CONNECTIONS else 'off'})")
        print(f"[TailDeck] Web app root: {WEBROOT} "
              f"({'found' if os.path.isfile(os.path.join(WEBROOT, 'index.html')) else 'not published'})")
        print(f"[TailDeck] Scripts folder: {SCRIPTS_DIR} "
              f"({'found' if os.path.isdir(SCRIPTS_DIR) else 'created on first save'})")
        print(f"[TailDeck] Notify a phone: python3 {os.path.basename(sys.argv[0])} notify \"message\"")
        print(f"[TailDeck] Passkey unlock: "
              f"{'rpId=' + auth_rpid() if auth_rpid() else 'no tailnet domain yet (WebAuthn needs one)'} "
              f"({len(_load_credentials())} credential(s))")
        if os.path.isfile(TLS_CA):
            print(f"[TailDeck] Guest CA: https://<laptop-ip>:{TLS_PORT}/taildeck-ca.crt "
                  f"(install once on an iPhone for the wss:// direct route)")
        for ip in local_ipv4_addresses():
            if tls_context is not None:
                print(f"[TailDeck] Same-hotspot URL: https://{ip}:{TLS_PORT}/   (recommended - allows dictation)")
                print(f"[TailDeck]                  http://{ip}:{PORT}/    (control only)")
            else:
                print(f"[TailDeck] Same-hotspot URL: http://{ip}:{PORT}/")

        if tls_context is not None:
            t = threading.Thread(
                target=run_ws_server, kwargs={"port": TLS_PORT, "tls_context": tls_context}, daemon=True
            )
            t.start()

        run_ws_server()
    except KeyboardInterrupt:
        print("\n[TailDeck] Daemon stopped.")
