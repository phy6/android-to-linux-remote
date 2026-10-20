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
import difflib
import wave
import time
import socket
import ssl
import struct
import atexit
import tarfile
import urllib.parse
import urllib.request
import hashlib
import hmac
import base64
import secrets
import threading
import subprocess
import tempfile
import shlex
import shutil
import re
import pwd
from http.server import HTTPServer, BaseHTTPRequestHandler

DAEMON_VERSION = "1.11.0"

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

OP_START, OP_STOP, OP_PCM, OP_TEXT, OP_PARTIAL, OP_OK, OP_CANCEL = 0x01, 0x02, 0x03, 0x04, 0x05, 0x01, 0x06


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
        self.on_partial = None
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
                if head[0] not in (OP_TEXT, OP_PARTIAL):
                    continue
                is_partial = head[0] == OP_PARTIAL
                raw = self._readn(sock, 4)
                if not raw:
                    break
                size = struct.unpack("!I", raw)[0]
                if size <= 0 or size > (1 << 20):
                    break
                payload = self._readn(sock, size)
                if not payload:
                    break
                cb = self.on_partial if is_partial else self.on_text
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

    def cancel(self, conn=None):
        """Abandon the session without typing anything. A gesture that opened a
        command or shortcut panel never meant to dictate, so its audio is
        discarded instead of recognised."""
        if conn is not None and self.owner is not None and self.owner is not conn:
            return
        self.owner = None
        if not self.sock:
            return
        try:
            print(f"[TailDeck] {_ts()} bridge -> OP_CANCEL after {self._sent_frames} PCM frames", flush=True)
        finally:
            self._reset()

    def _reset(self):
        # Close the old socket, not just the reference. The recogniser treats an
        # open socket as a live session: abandoning one without closing it left
        # the mic "busy" so every later press (phone or F9) was refused.
        sock = self.sock
        self.sock = None
        self.owner = None
        if sock is not None:
            try:
                sock.sendall(bytes([OP_CANCEL]))
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass


class RecordSink:
    """Writes raw phone PCM to a WAV on the laptop.

    Deliberately separate from DictationBridge. Dictation is speech-tuned on the
    phone (noise suppression / AGC / echo-cancel on) and its whole purpose is to
    reach the recogniser and type text. A *recording* wants the untouched signal
    and a file on disk, so it has its own messages ("record_audio"), never touches
    vosk, and takes whatever format the phone declares. Only the connection that
    opened the session may feed or close it.
    """

    def __init__(self):
        self.wav = None
        self.path = None
        self.owner = None
        self.frames = 0
        self.sample_rate = 16000
        self.lock = threading.Lock()

    def start(self, owner=None, sample_rate=16000, label=""):
        self._reset()
        try:
            os.makedirs(TAKES_DIR, exist_ok=True)
        except OSError as e:
            print(f"[TailDeck] record dir failed: {e}", flush=True)
            return None
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", label).strip("_")
        name = f"{stamp}-{safe}.wav" if safe else f"{stamp}.wav"
        self.path = os.path.join(TAKES_DIR, name)
        self.sample_rate = int(sample_rate) or 16000
        try:
            # wave writes the header on first write and fixes the sizes on close,
            # so the file is a valid WAV even if the session is cut short.
            self.wav = wave.open(self.path, "wb")
            self.wav.setnchannels(1)
            self.wav.setsampwidth(2)
            self.wav.setframerate(self.sample_rate)
        except Exception as e:
            print(f"[TailDeck] record start failed: {e}", flush=True)
            self._reset()
            return None
        self.owner = owner
        self.frames = 0
        print(f"[TailDeck] {_ts()} record -> {self.path} @ {self.sample_rate} Hz", flush=True)
        return self.path

    def audio(self, pcm, conn=None):
        if self.wav is None or not pcm:
            return
        if conn is not None and self.owner is not None and self.owner is not conn:
            return
        try:
            with self.lock:
                self.wav.writeframes(pcm)
                self.frames += 1
        except Exception as e:
            print(f"[TailDeck] record write dropped: {e}", flush=True)

    def stop(self, conn=None, discard=False):
        """Finalise the WAV. `discard` throws the partial away instead of keeping it."""
        if conn is not None and self.owner is not None and self.owner is not conn:
            return None
        path, frames = self.path, self.frames
        self._reset()
        if path:
            if discard:
                try:
                    os.remove(path)
                except OSError:
                    pass
                print(f"[TailDeck] {_ts()} record discarded after {frames} frames", flush=True)
                return None
            try:
                size = os.path.getsize(path)
            except OSError:
                size = 0
            print(f"[TailDeck] {_ts()} record saved {path} frames={frames} bytes={size}", flush=True)
        return path

    def _reset(self):
        w = self.wav
        self.wav = None
        self.owner = None
        self.path = None
        if w is not None:
            try:
                w.close()
            except Exception:
                pass


def _ts():
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


DICTATION = DictationBridge()
RECORDING = RecordSink()
SESSION_TYPE = os.environ.get("XDG_SESSION_TYPE", "").lower()
if SESSION_TYPE not in ("x11", "wayland"):
    if os.environ.get("WAYLAND_DISPLAY"):
        SESSION_TYPE = "wayland"
    elif os.environ.get("DISPLAY"):
        SESSION_TYPE = "x11"
    elif any(os.path.exists(f"/tmp/.X11-unix/X{n}") for n in ("0", "1")):
        SESSION_TYPE = "x11"
    else:
        SESSION_TYPE = "unknown"
if SESSION_TYPE == "x11" and not os.environ.get("DISPLAY"):
    for _n in ("0", "1"):
        if os.path.exists(f"/tmp/.X11-unix/X{_n}"):
            os.environ["DISPLAY"] = f":{_n}"
            break
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
                    # Media transport keys for the phone's media row. A uinput
                    # device only advertises the keys it declared, so without
                    # these the play/next/prev/stop events are delivered but X
                    # has no keycode for them and the player never reacts.
                    e.KEY_PLAYPAUSE, e.KEY_NEXTSONG, e.KEY_PREVIOUSSONG, e.KEY_STOPCD,
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
    # YouTube's own shortcuts, sent as the literal keys. The media keys above
    # depend on the browser binding XF86AudioPlay to the page's media session,
    # which is not always wired; 'k' and '0' are handled by the player itself.
    "yt_playpause": {"evdev": "KEY_K", "xdotool": "k", "pyautogui": "k", "code": 37},
    "yt_replay": {"evdev": "KEY_0", "xdotool": "0", "pyautogui": "0", "code": 11},
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

# Phase 2: a sandboxed folder the phone may browse, download from and upload
# into. It is the only tree the files API can reach; nothing outside it is
# served. Uploads are raw request bodies (filename in the query string) so the
# daemon stays stdlib-only -- no multipart parser needed.
SHARE_DIR = os.environ.get(
    "TAILDECK_SHARE_DIR", os.path.join(os.path.expanduser("~"), "taildeck-share")
)
MAX_UPLOAD = int(os.environ.get("TAILDECK_MAX_UPLOAD", str(64 * 1024 * 1024)))

# Share links: a token URL that hands someone a *subfolder* of the share, for a
# while, with an optional write permission and an optional single-use limit.
# The store is owner-only (0600) and sits beside the other taildeck config. See
# plans/safe-share-links.md for the threat model -- a link narrows what a
# recipient can reach; it is not a boundary against someone already on the LAN.
SHARES_FILE = os.environ.get(
    "TAILDECK_SHARES_FILE",
    os.path.join(os.path.expanduser("~"), ".config", "taildeck", "shares.json"),
)
SHARES_LOCK = threading.Lock()

# Raw phone audio, recorded to the laptop. Separate from dictation: this is the
# music/voice path (no recogniser, no typing), written as a WAV for the user to
# keep. It exists so a phone on the music stand or guitar can be a wireless mic
# for local practice recording -- see plans/mic-requirements.md (options A/B).
TAKES_DIR = os.environ.get(
    "TAILDECK_TAKES_DIR", os.path.join(os.path.expanduser("~"), "taildeck-takes")
)

# Phase 2: clipboard bridge. Reading and setting the desktop clipboard is always
# available; watching it and pushing changes to phones is opt-in, because a
# synced clipboard can ferry secrets between devices without the user noticing.
CLIPBOARD_WATCH = os.environ.get("TAILDECK_CLIPBOARD_WATCH", "0") == "1"
CLIPBOARD_POLL = float(os.environ.get("TAILDECK_CLIPBOARD_POLL", "1.5"))
# How often the now-playing poller asks MPRIS what the laptop is playing.
MEDIA_POLL = float(os.environ.get("TAILDECK_MEDIA_POLL", "2.0"))
CLIPBOARD_MAX = int(os.environ.get("TAILDECK_CLIPBOARD_MAX", str(64 * 1024)))

# Phase 3: screen view. Frames come from ffmpeg's x11grab (the whole X screen,
# which spans every monitor) re-encoded to JPEG. The live feed is a
# multipart/x-mixed-replace MJPEG stream a WebView can render in a plain <img>.
SCREEN_MAX_WIDTH = int(os.environ.get("TAILDECK_SCREEN_MAX_WIDTH", "1920"))
SCREEN_DEFAULT_WIDTH = int(os.environ.get("TAILDECK_SCREEN_DEFAULT_WIDTH", "1280"))
SCREEN_QUALITY = int(os.environ.get("TAILDECK_SCREEN_QUALITY", "6"))  # ffmpeg -q:v, 2 best .. 31 worst
SCREEN_STREAM_FPS = float(os.environ.get("TAILDECK_SCREEN_STREAM_FPS", "5"))

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

# --- Device auth ------------------------------------------------------------
#
# The websocket and every mutating API used to be open to anyone who could
# reach the port. A phone now holds a device token, issued once from a pairing
# code and stored only as a hash here. Local (loopback) requests are exempt so
# the laptop can still pair itself from http://localhost:<PORT>; a proxied
# request is never local (X-Forwarded-For present). See plans/security-hardening.md.
DEVICES_FILE = os.environ.get(
    "TAILDECK_DEVICES_FILE",
    os.path.join(os.path.expanduser("~"), ".config", "taildeck", "devices.json"),
)
DEVICE_TOKEN_ENV = os.environ.get("TAILDECK_DEVICE_TOKEN", "")
ALLOWED_ORIGINS_ENV = [
    item.strip().rstrip("/")
    for item in os.environ.get("TAILDECK_ALLOWED_ORIGINS", "").split(",")
    if item.strip()
]
PAIRING_TTL = int(os.environ.get("TAILDECK_PAIRING_TTL", 300))
PAIRING_PENDING = {}
PAIRING_LOCK = threading.Lock()
# Read-modify-write of the device store happens from request and websocket
# threads; without this a lastSeen write could clobber a concurrent revoke.
DEVICES_LOCK = threading.Lock()
_LAST_SEEN_SAVED = {}
ALLOWED_ORIGINS_CACHE = {"at": 0.0, "items": set()}
# _http has no request object, and a socket cannot carry attributes, so the
# current request's Origin rides on the handler thread.
REQUEST_ORIGIN = threading.local()

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
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".xml": "application/xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _http(conn, status, ctype, body, cache="no-cache", extra=""):
    # The app may be served from GitHub Pages while the daemon sits on the
    # laptop, so some responses are cross-origin. Echo only origins that belong
    # to this app; a wildcard here would let any visited page call the daemon.
    origin = getattr(REQUEST_ORIGIN, "origin", "")
    cors = "Vary: Origin\r\n"
    if origin and _origin_allowed(origin):
        cors += (
            f"Access-Control-Allow-Origin: {origin}\r\n"
            "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Authorization, Content-Type\r\n"
        )
    head = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Cache-Control: {cache}\r\n"
        f"{cors}"
        f"{extra}"
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

    base = os.path.basename(full)
    if base in ("index.html", "sw.js", "manifest.webmanifest"):
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


# --- APPS / POWER / DISPLAYS API --------------------------------------------
#
# Read-mostly endpoints that let the phone act as a fuller remote: list and
# launch installed GUI apps, lock/suspend the session, drive the backlight, and
# list/switch display modes. Every external call is by argv (never a shell) and
# every input is validated against a freshly enumerated set.


def _run(cmd, timeout=5, env=None, data=None):
    """Run argv and capture text output. Never raises; (rc, out, err) always.
    Pass `data` (str) to feed stdin -- used to set the clipboard without a
    shell pipeline."""
    try:
        kwargs = dict(capture_output=True, text=True, timeout=timeout, env=env)
        if data is None:
            kwargs["stdin"] = subprocess.DEVNULL
        res = subprocess.run(cmd, input=data, **kwargs)
        return res.returncode, res.stdout or "", res.stderr or ""
    except Exception as e:
        return 127, "", str(e)


def _has_command(cmd):
    return shutil.which(cmd) is not None


def _session_env():
    """Env for desktop commands. The daemon runs as a user service, so it
    already carries DISPLAY/DBUS; fill DISPLAY only if it is somehow missing."""
    env = dict(os.environ)
    if "x11" in SESSION_TYPE and not env.get("DISPLAY"):
        env["DISPLAY"] = ":0"
    return env


# Where .desktop entries live, in precedence order (user overrides system).
APP_DIRS = [
    os.path.expanduser("~/.local/share/applications"),
    "/usr/local/share/applications",
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
    os.path.expanduser("~/.local/share/flatpak/exports/share/applications"),
    "/var/lib/snapd/desktop/applications",
]


def _desktop_entry(path):
    """Parse the [Desktop Entry] group of a .desktop file into a dict."""
    fields = {}
    in_section = False
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.rstrip("\n")
                if line.startswith("["):
                    in_section = line.strip() == "[Desktop Entry]"
                    continue
                if not in_section or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if "[" in key:  # skip localized keys such as Name[de]
                    continue
                fields[key] = value.strip()
    except Exception:
        return None
    return fields or None


def _exec_basename(exec_line):
    """The program name in an Exec line, used to match WM_CLASS values.

    Desktop entries often launch a differently-named binary than their id
    (org.gnome.TextEditor -> gnome-text-editor), so keep this alias for window
    icon matching. Returns "" for an unusable line.
    """
    try:
        argv = shlex.split(_strip_exec_field_codes(exec_line or ""))
    except Exception:
        argv = (exec_line or "").split()
    for part in argv:
        if not part or "=" in part:
            continue
        return os.path.basename(part)
    return ""


def _list_apps():
    """Installed GUI applications, de-duplicated by desktop-file id."""
    found = {}
    for directory in APP_DIRS:
        try:
            names = sorted(os.listdir(directory))
        except Exception:
            continue
        for name in names:
            if not name.endswith(".desktop"):
                continue
            app_id = name[: -len(".desktop")]
            if app_id in found:
                continue
            fields = _desktop_entry(os.path.join(directory, name))
            if not fields:
                continue
            if fields.get("Type", "Application") != "Application":
                continue
            if fields.get("NoDisplay", "").lower() == "true":
                continue
            if fields.get("Hidden", "").lower() == "true":
                continue
            if not fields.get("Name") or not fields.get("Exec"):
                continue
            icon = (fields.get("Icon") or "").strip()
            resolved = _resolve_icon(icon)
            found[app_id] = {
                "id": app_id,
                "name": fields["Name"],
                "comment": fields.get("Comment", ""),
                "categories": [c for c in fields.get("Categories", "").split(";") if c],
                "icon": icon,
                "iconPath": resolved or "",
                "iconVersion": _icon_version(resolved),
                "wmClass": (fields.get("StartupWMClass") or "").strip(),
                "execName": _exec_basename(fields.get("Exec", "")),
                "path": os.path.join(directory, name),
            }
    return sorted(found.values(), key=lambda a: a["name"].lower())


def _find_app(app_id):
    """Resolve an id to (desktop_path, fields) only if it is a real entry."""
    if not app_id or "/" in app_id or "\\" in app_id or app_id.startswith(".") or len(app_id) > 128:
        return None
    for directory in APP_DIRS:
        full = os.path.join(directory, app_id + ".desktop")
        if os.path.isfile(full):
            fields = _desktop_entry(full)
            if fields and fields.get("Type", "Application") == "Application":
                return full, fields
    return None


# A .desktop file names its icon ("brave-browser", "org.xfce.terminal") or gives
# an absolute path. The phone wants an actual picture, so resolve the name here.
ICON_THEME_DIRS = [
    os.path.expanduser("~/.local/share/icons"),
    os.path.expanduser("~/.icons"),
    "/usr/local/share/icons",
    "/usr/share/icons",
    "/var/lib/flatpak/exports/share/icons",
    os.path.expanduser("~/.local/share/flatpak/exports/share/icons"),
]
ICON_PIXMAP_DIRS = [
    os.path.expanduser("~/.local/share/pixmaps"),
    "/usr/local/share/pixmaps",
    "/usr/share/pixmaps",
]
# Bigger rasters read better at phone size; scalable costs the most bytes for the
# same result, so it ranks last.
ICON_SIZES = ("256x256", "128x128", "96x96", "64x64", "48x48", "32x32", "scalable")
ICON_HINTS = ("apps", "applications", "preferences", "devices", "places",
              "mimetypes", "actions", "categories", "status")
ICON_EXTS = (".png", ".svg", ".webp")
# hicolor is the spec fallback every application must install into, so it wins
# ties; the rest are ordered to match this machine before a full directory scan.
ICON_THEME_ORDER = ("hicolor", "Adwaita", "breeze", "Papirus", "Yaru", "elementary")

_ICON_INDEX = None
_ICON_INDEX_LOCK = threading.Lock()
_ICON_CACHE = {}


def _icon_theme_names():
    names = list(ICON_THEME_ORDER)
    for root in ICON_THEME_DIRS:
        try:
            for entry in os.listdir(root):
                if os.path.isdir(os.path.join(root, entry)) and entry not in names:
                    names.append(entry)
        except Exception:
            continue
    return names


def _icon_index():
    """name -> best icon file, built once by listing the theme app folders.

    Listing beats probing: a name has to be tried against every root/theme/size
    combination otherwise, which is thousands of failed stats per icon.
    """
    global _ICON_INDEX
    with _ICON_INDEX_LOCK:
        if _ICON_INDEX is not None:
            return _ICON_INDEX
        best = {}
        for root in ICON_THEME_DIRS:
            for theme in _icon_theme_names():
                for size_rank, size in enumerate(ICON_SIZES):
                    for hint_rank, hint in enumerate(ICON_HINTS):
                        directory = os.path.join(root, theme, size, hint)
                        try:
                            entries = os.listdir(directory)
                        except Exception:
                            continue
                        for entry in entries:
                            base, ext = os.path.splitext(entry)
                            ext = ext.lower()
                            if ext not in ICON_EXTS:
                                continue
                            score = (size_rank, hint_rank, ICON_EXTS.index(ext))
                            key = base.lower()
                            if key not in best or score < best[key][0]:
                                best[key] = (score, os.path.join(directory, entry))
        _ICON_INDEX = {name: hit[1] for name, hit in best.items()}
        return _ICON_INDEX


def _resolve_icon_uncached(name):
    """Best-effort icon file for a .desktop Icon= value. None when unresolved."""
    name = (name or "").strip()
    if not name or len(name) > 256:
        return None
    if os.path.isabs(name):
        try:
            if os.path.isfile(name) and os.path.getsize(name) < 4 * 1024 * 1024:
                return name
        except Exception:
            pass
        return None
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    base, ext = os.path.splitext(name)
    if ext.lower() in ICON_EXTS or ext.lower() == ".xpm":
        name = base
    hit = _icon_index().get(name.lower())
    if hit:
        return hit
    for directory in ICON_PIXMAP_DIRS:
        for suffix in ICON_EXTS:
            candidate = os.path.join(directory, name + suffix)
            if os.path.isfile(candidate):
                return candidate
    return None


def _resolve_icon(name):
    key = (name or "").strip()
    if key in _ICON_CACHE:
        return _ICON_CACHE[key]
    hit = _resolve_icon_uncached(key)
    _ICON_CACHE[key] = hit
    return hit


def _icon_version(path):
    """Stable id for an icon file, so the phone re-fetches only when it changes."""
    if not path:
        return ""
    try:
        st = os.stat(path)
    except Exception:
        return ""
    return f"{int(st.st_mtime)}-{st.st_size}"


def _strip_exec_field_codes(exec_line):
    """Drop %f/%u/%F/%U/%i/%c/%k placeholders from a .desktop Exec line."""
    out = []
    i, n = 0, len(exec_line)
    while i < n:
        if exec_line[i] == "%" and i + 1 < n:
            if exec_line[i + 1] == "%":
                out.append("%")
            i += 2
            continue
        out.append(exec_line[i])
        i += 1
    return "".join(out).strip()


def _launch_app(app_id):
    """Launch a discovered .desktop app. Returns (ok, detail)."""
    hit = _find_app(app_id)
    if not hit:
        return False, "unknown app"
    _path, fields = hit
    env = _session_env()
    if _has_command("gtk-launch"):
        rc, _out, _err = _run(["gtk-launch", app_id], timeout=5, env=env)
        if rc == 0:
            return True, "gtk-launch"
    argv = []
    try:
        argv = shlex.split(_strip_exec_field_codes(fields.get("Exec", "")))
    except Exception:
        argv = _strip_exec_field_codes(fields.get("Exec", "")).split()
    if not argv:
        return False, "no exec line"
    try:
        subprocess.Popen(
            argv, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        return False, str(e)
    return True, "spawn"


def _focus_window(match):
    """Raise a window by title substring. X11 only, and only if xdotool exists."""
    if "x11" not in SESSION_TYPE or not _has_command("xdotool"):
        return False, "unsupported"
    rc, out, _err = _run(["xdotool", "search", "--name", match], timeout=5, env=_session_env())
    ids = [ln.strip() for ln in out.splitlines() if ln.strip().isdigit()]
    if not ids:
        return False, "no match"
    rc, _out, err = _run(["xdotool", "windowactivate", "--sync", ids[-1]], timeout=5, env=_session_env())
    return (rc == 0), ("ok" if rc == 0 else err)


# --- Window list: the real Alt+Tab entries -----------------------------------
#
# X11 exposes the window manager's stacking list. Reversed, top-most first, it
# is the same order xfwm4/Openbox/etc. cycle with Alt+Tab (verified against the
# xfwm4 switcher overlay on the HP). Filtering out docks, panels, desktops and
# notifications leaves the entries a user expects. Wayland compositors do not
# expose an equivalent standard list, so the phone falls back to app_switch.

_WINDOWS_CACHE = {"at": 0.0, "data": None}
_WINDOWS_CACHE_LOCK = threading.Lock()
_WINDOW_APP_CACHE = {"at": 0.0, "index": {}}
_WINDOW_APP_CACHE_LOCK = threading.Lock()
_WINDOW_TYPES_SKIP = (
    "DOCK", "DESKTOP", "SPLASH", "NOTIFICATION", "TOOLTIP",
    "MENU", "DROPDOWN", "POPUP", "COMBO", "TOOLBAR",
)


def _parse_xprop_lines(out):
    """Parse xprop output, which uses `=` for strings and `:` for id lists."""
    props = {}
    for line in out.splitlines():
        separator = "=" if "=" in line else (":" if ":" in line else "")
        if not separator:
            continue
        key, _, value = line.partition(separator)
        atom = key.split("(", 1)[0].strip()
        value = value.strip()
        if not atom or value == "not found.":
            continue
        props[atom] = value
    return props


def _xprop_props(wid, names, env):
    """Read selected xprop atoms for one window as {atom: raw value}."""
    rc, out, _err = _run(["xprop", "-id", wid, *names], timeout=4, env=env)
    if rc != 0:
        return {}
    return _parse_xprop_lines(out)


def _xprop_string(value):
    """Unquote an xprop string value, preserving spaces and escapes."""
    text = (value or "").strip()
    if not text:
        return ""
    try:
        parts = shlex.split(text)
    except Exception:
        return text.strip('"')
    return " ".join(parts)


def _norm_window_token(value):
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def _window_app_index():
    """Alias buckets -> desktop entry, cached so polling the wheel stays cheap.

    Separate buckets matter: a Chrome PWA can share the `google-chrome` Exec
    name with the browser itself. Matching the class against ids and
    StartupWMClass first keeps the real Chrome window on Chrome, not on whichever
    PWA happens to sort first alphabetically.
    """
    now = time.time()
    with _WINDOW_APP_CACHE_LOCK:
        cached = _WINDOW_APP_CACHE.get("index") or {}
        if cached and now - _WINDOW_APP_CACHE["at"] < 30:
            return cached
    index = {"wmClass": {}, "id": {}, "name": {}, "exec": {}}
    for app in _list_apps():
        for bucket, alias in (
            ("wmClass", app.get("wmClass")),
            ("id", app.get("id")),
            ("name", app.get("name")),
            ("exec", app.get("execName")),
        ):
            key = _norm_window_token(alias)
            if key and key not in index[bucket]:
                index[bucket][key] = app
    with _WINDOW_APP_CACHE_LOCK:
        _WINDOW_APP_CACHE["at"] = now
        _WINDOW_APP_CACHE["index"] = index
    return index


def _match_window_app(index, instance, wm_class):
    """Best desktop entry for a WM_CLASS pair, or None for an unknown app."""
    if not index:
        return None
    for raw in (wm_class, instance):
        key = _norm_window_token(raw)
        if not key:
            continue
        for bucket in ("wmClass", "id", "name", "exec"):
            hit = index[bucket].get(key)
            if hit:
                return hit
    # Unknown vendored apps: stay conservative. Only consider identity aliases,
    # never Exec (where browser web-apps would win a near-match).
    candidates = {}
    for bucket in ("wmClass", "id", "name"):
        candidates.update(index[bucket])
    for raw in (wm_class, instance):
        key = _norm_window_token(raw)
        if len(key) < 5:
            continue
        match = difflib.get_close_matches(key, candidates.keys(), n=1, cutoff=0.9)
        if match:
            return candidates[match[0]]
    return None


def _list_windows():
    """The current Alt+Tab entries, top-most first. X11 only."""
    if "x11" not in SESSION_TYPE or not _has_command("xprop"):
        return {
            "supported": False,
            "reason": "Alt+Tab window listing needs an X11 session and xprop",
            "windows": [],
        }

    now = time.time()
    with _WINDOWS_CACHE_LOCK:
        data = _WINDOWS_CACHE.get("data")
        if data is not None and now - _WINDOWS_CACHE["at"] < 1.5:
            return data

    env = _session_env()
    rc, root_out, _err = _run(
        ["xprop", "-root", "_NET_CLIENT_LIST_STACKING", "_NET_ACTIVE_WINDOW", "_NET_CURRENT_DESKTOP"],
        timeout=4, env=env,
    )
    root_props = _parse_xprop_lines(root_out)

    stacking = re.findall(
        r"0x[0-9a-fA-F]+", root_props.get("_NET_CLIENT_LIST_STACKING", "")
    )
    if rc != 0 or not stacking:
        result = {
            "supported": False,
            "reason": "window manager does not expose _NET_CLIENT_LIST_STACKING",
            "windows": [],
        }
        with _WINDOWS_CACHE_LOCK:
            _WINDOWS_CACHE.update(at=now, data=result)
        return result

    active_ids = re.findall(r"0x[0-9a-fA-F]+", root_props.get("_NET_ACTIVE_WINDOW", ""))
    active = active_ids[0] if active_ids else ""
    desktop_match = re.search(r"-?\d+", root_props.get("_NET_CURRENT_DESKTOP", ""))
    current_desktop = int(desktop_match.group(0)) if desktop_match else None

    index = _window_app_index()
    items = []
    seen = set()
    # Stacking order is bottom-to-top; the switcher presents top-most first.
    for wid in reversed(stacking):
        if wid in seen:
            continue
        seen.add(wid)
        props = _xprop_props(
            wid,
            ("WM_CLASS", "_NET_WM_NAME", "WM_NAME", "_NET_WM_WINDOW_TYPE",
             "_NET_WM_STATE", "_NET_WM_DESKTOP"),
            env,
        )
        if not props:
            continue

        types = props.get("_NET_WM_WINDOW_TYPE", "").upper()
        if any(("_" + t) in types for t in _WINDOW_TYPES_SKIP):
            continue
        states = props.get("_NET_WM_STATE", "").upper()
        if "_NET_WM_STATE_SKIP_TASKBAR" in states:
            continue
        desktop_raw = props.get("_NET_WM_DESKTOP", "")
        desktop_match = re.search(r"-?\d+", desktop_raw)
        if current_desktop is not None and desktop_match:
            desktop = int(desktop_match.group(0))
            # 4294967295 (0xffffffff) means "on all desktops".
            if desktop != current_desktop and desktop != 4294967295:
                continue

        try:
            classes = shlex.split(props.get("WM_CLASS", ""))
        except Exception:
            classes = []
        instance = classes[0] if classes else ""
        wm_class = classes[-1] if classes else ""
        title = _xprop_string(props.get("_NET_WM_NAME", "")) or _xprop_string(
            props.get("WM_NAME", "")
        )
        if not title and not wm_class:
            continue

        app = _match_window_app(index, instance, wm_class)
        items.append({
            "id": wid,
            "title": title,
            "appId": app["id"] if app else "",
            "appName": app["name"] if app else (wm_class or title or "Window"),
            "wmClass": wm_class or instance,
            "iconVersion": app["iconVersion"] if app else "",
            "active": wid == active,
        })
        if len(items) >= 40:
            break

    # The active window is normally top-most already; make that invariant so the
    # phone can centre it without a second sort.
    if active:
        items.sort(key=lambda w: 0 if w["id"] == active else 1)

    result = {"supported": True, "reason": "", "windows": items}
    with _WINDOWS_CACHE_LOCK:
        _WINDOWS_CACHE.update(at=now, data=result)
    return result


def _focus_window_id(wid):
    """Activate one exact window id (rather than a title substring)."""
    if "x11" not in SESSION_TYPE or not _has_command("xdotool"):
        return False, "unsupported"
    value = (wid or "").strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]+|\d+", value):
        return False, "bad window id"
    rc, _out, err = _run(
        ["xdotool", "windowactivate", "--sync", value], timeout=5, env=_session_env()
    )
    if rc == 0:
        return True, "ok"
    # Some WMs refuse activate on a window that is already focused; raising it is
    # still the correct intent and gives the user visible feedback.
    rc, _out, raise_err = _run(
        ["xdotool", "windowraise", value], timeout=5, env=_session_env()
    )
    return (rc == 0), ("ok" if rc == 0 else (err or raise_err))


def _backlight_device():
    """(name, max, current) for the first backlight device, or None."""
    root = "/sys/class/backlight"
    try:
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            bpath = os.path.join(d, "brightness")
            mpath = os.path.join(d, "max_brightness")
            if not (os.path.isfile(bpath) and os.path.isfile(mpath)):
                continue
            with open(mpath) as fh:
                mx = int(fh.read().strip() or "0")
            with open(bpath) as fh:
                cur = int(fh.read().strip() or "0")
            if mx > 0:
                return name, mx, cur
    except Exception:
        return None
    return None


def _brightness_pct():
    dev = _backlight_device()
    if not dev:
        return None
    _name, mx, cur = dev
    return round(cur * 100 / mx)


def _logind_session_path():
    """Object path of the user's graphical session, for logind SetBrightness.

    A systemd --user service belongs to no session, so `/session/self` does not
    resolve for it and the call is refused. Resolve the session id with
    loginctl and encode it the way logind addresses objects (each character
    becomes '_' + two hex digits).
    """
    rc, out, _err = _run(
        ["loginctl", "show-user", _default_user(), "-p", "Display", "--value"], timeout=5
    )
    sid = (out or "").strip()
    if rc != 0 or not sid:
        return None
    return "/org/freedesktop/login1/session/" + "".join(
        "_" + format(ord(ch), "02x") for ch in sid
    )


def _set_brightness_pct(pct):
    """Set backlight to 1..100%. Prefers brightnessctl, then logind's
    Session.SetBrightness (the session owner may call it with no extra device
    permission), then a direct sysfs write."""
    try:
        pct = max(1, min(100, int(pct)))
    except Exception:
        return False, "bad value"
    dev = _backlight_device()
    if not dev:
        return False, "no backlight"
    name, mx, _cur = dev
    target = max(1, round(mx * pct / 100))
    if _has_command("brightnessctl"):
        rc, _out, _err = _run(["brightnessctl", "set", f"{pct}%"], timeout=5)
        if rc == 0:
            return True, "brightnessctl"
    session_path = _logind_session_path()
    if _has_command("busctl") and session_path:
        rc, _out, _err = _run([
            "busctl", "call", "org.freedesktop.login1",
            session_path,
            "org.freedesktop.login1.Session", "SetBrightness",
            "ssu", "backlight", name, str(target),
        ], timeout=5)
        if rc == 0:
            return True, "logind"
    try:
        with open(os.path.join("/sys/class/backlight", name, "brightness"), "w") as fh:
            fh.write(str(target))
        return True, "sysfs"
    except Exception as e:
        return False, str(e)


def _power_action(action, value=None):
    env = _session_env()
    if action == "lock":
        if not _has_command("loginctl"):
            return False, "unsupported"
        rc, _out, err = _run(["loginctl", "lock-session"], timeout=5, env=env)
        return (rc == 0), ("locked" if rc == 0 else err)
    if action == "suspend":
        if not _has_command("systemctl"):
            return False, "unsupported"
        rc, _out, err = _run(["systemctl", "suspend"], timeout=5, env=env)
        return (rc == 0), ("suspending" if rc == 0 else err)
    if action in ("brightness_up", "brightness_down"):
        cur = _brightness_pct()
        step = 5 if action == "brightness_up" else -5
        return _set_brightness_pct((cur if cur is not None else 50) + step)
    if action == "brightness_set":
        if value is None:
            return False, "value required"
        return _set_brightness_pct(value)
    return False, "unknown action"


def _displays():
    """Parse `xrandr --query` into outputs with their modes. X11 only."""
    if not _has_command("xrandr"):
        return []
    rc, out, _err = _run(["xrandr", "--query"], timeout=5, env=_session_env())
    if rc != 0:
        return []
    displays = []
    current = None
    for line in out.splitlines():
        if line and not line[0].isspace():
            m = re.match(r"^(\S+)\s+(connected|disconnected)", line)
            if not m:
                continue
            # xrandr prints offsets with "%dx%d+%d+%d", so a monitor above or
            # left of the origin appears as "+0+-1080". Match the sign too, or
            # the whole geometry is dropped and the screen disappears from the
            # phone's desk model.
            geometry = re.search(r"(\d+)x(\d+)\+(-?\d+)\+(-?\d+)", line)
            # The current rotation is the bare word before the parenthetical,
            # e.g. "1080x1920+0+0 left (normal left inverted right ...)". The
            # parenthetical itself is the fixed list of supported rotations, so
            # reading its first word would always report "normal". The WxH above
            # is already post-rotation; the field lets the phone draw a portrait
            # screen the right way up.
            rotation_word = (
                re.search(r"^\s+(normal|left|right|inverted)\b", line[geometry.end():])
                if geometry
                else None
            )
            rotation = {"normal": 0, "right": 90, "inverted": 180, "left": 270}.get(
                rotation_word.group(1) if rotation_word else "normal", 0
            )
            current = {
                "output": m.group(1),
                "connected": m.group(2) == "connected",
                "current": f"{geometry.group(1)}x{geometry.group(2)}" if geometry else None,
                # Offsets matter: they are how the client works out which monitor
                # a pointer is on and which edges are on the desktop's boundary.
                "width": int(geometry.group(1)) if geometry else None,
                "height": int(geometry.group(2)) if geometry else None,
                "x": int(geometry.group(3)) if geometry else None,
                "y": int(geometry.group(4)) if geometry else None,
                "rotation": rotation,
                "modes": [],
            }
            displays.append(current)
        elif current is not None:
            m = re.match(r"^\s+(\d+x\d+)\s", line)
            if m and m.group(1) not in current["modes"]:
                current["modes"].append(m.group(1))
    return displays


def _pointer_location():
    """Pointer position and the output it sits on. X11 via xdotool."""
    if not _has_command("xdotool"):
        return None
    rc, out, _err = _run(["xdotool", "getmouselocation", "--shell"], timeout=3, env=_session_env())
    if rc != 0:
        return None
    x = y = None
    for line in out.splitlines():
        try:
            if line.startswith("X="):
                x = int(line[2:])
            elif line.startswith("Y="):
                y = int(line[2:])
        except ValueError:
            continue
    if x is None or y is None:
        return None
    output = None
    for d in _displays():
        if d.get("x") is None or not d.get("connected"):
            continue
        if d["x"] <= x < d["x"] + d["width"] and d["y"] <= y < d["y"] + d["height"]:
            output = d["output"]
            break
    return {"x": x, "y": y, "output": output}


def _set_display_mode(output, mode):
    if not _has_command("xrandr"):
        return False, "unsupported"
    known = {d["output"] for d in _displays()}
    if output not in known:
        return False, "unknown output"
    if not re.match(r"^\d+x\d+$", mode or ""):
        return False, "bad mode"
    rc, _out, err = _run(["xrandr", "--output", output, "--mode", mode], timeout=8, env=_session_env())
    return (rc == 0), ("ok" if rc == 0 else err)


# xrandr names rotations while /api/displays reports degrees clockwise; keep the
# translation in one place so the editor can send the same numbers it draws.
_DISPLAY_ROTATION_WORD = {0: "normal", 90: "right", 180: "inverted", 270: "left"}
_DISPLAY_REFLECTION_WORDS = {"none", "x", "y", "xy"}


def _display_rotation_word(value):
    """Map 0/90/180/270 (or an xrandr word) to an xrandr rotation word."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value in _DISPLAY_ROTATION_WORD.values():
        return value
    try:
        degrees = int(value)
    except (TypeError, ValueError):
        return None
    return _DISPLAY_ROTATION_WORD.get(degrees % 360)


def _display_coord(value):
    """A signed virtual-desktop coordinate, or None when not a plain integer."""
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if abs(number) > 100000:
        return None
    return number


def _set_display_layout(changes):
    """Move/rotate one or more outputs, e.g. dragging screens in the phone editor.

    Each change is `{output, x?, y?, rotation?, mode?, reflect?, primary?}`.
    x/y are post-rotation top-left offsets in the virtual desktop. All changes
    go to one `xrandr` invocation so the server sees a single new layout rather
    than a sequence of half-applied ones.
    """
    if not _has_command("xrandr"):
        return False, "unsupported"
    displays = _displays()
    known = {d["output"]: d for d in displays if d.get("connected")}
    if not changes:
        return False, "no changes"
    if len(changes) > 16:
        return False, "too many outputs"
    args = ["xrandr"]
    seen = set()
    primary_seen = False
    for change in changes:
        if not isinstance(change, dict):
            return False, "bad change"
        output = str(change.get("output") or "")
        if output not in known:
            return False, f"unknown output: {output or '(empty)'}"
        if output in seen:
            return False, f"duplicate output: {output}"
        seen.add(output)
        args += ["--output", output]

        mode = change.get("mode")
        if mode is not None:
            mode = str(mode)
            if not re.match(r"^\d+x\d+$", mode):
                return False, f"bad mode: {mode}"
            args += ["--mode", mode]

        has_x = "x" in change
        has_y = "y" in change
        if has_x != has_y:
            return False, f"both x and y are required for {output}"
        if has_x:
            x = _display_coord(change.get("x"))
            y = _display_coord(change.get("y"))
            if x is None or y is None:
                return False, f"bad position for {output}"
            args += ["--pos", f"{x}x{y}"]

        if "rotation" in change:
            word = _display_rotation_word(change.get("rotation"))
            if word is None:
                return False, f"bad rotation for {output}"
            args += ["--rotate", word]

        if "reflect" in change:
            reflect = str(change.get("reflect") or "").lower()
            if reflect not in _DISPLAY_REFLECTION_WORDS:
                return False, f"bad reflection for {output}"
            args += ["--reflect", reflect]

        if change.get("primary") is True:
            if primary_seen:
                return False, "only one output can be primary"
            primary_seen = True
            args += ["--primary"]

    rc, _out, err = _run(args, timeout=12, env=_session_env())
    return (rc == 0), ("ok" if rc == 0 else (err or "xrandr failed").strip())


# --- CLIPBOARD / FILES API --------------------------------------------------
#
# Clipboard: read/write the desktop selection as text. Files: a sandboxed view
# of SHARE_DIR for listing, download and upload. Both stay within the existing
# safety model -- argv-only calls (no shell) and paths confined to one root.


def _clipboard_read():
    """Read the desktop clipboard as text. (ok, text_or_reason)."""
    env = _session_env()
    if SESSION_TYPE == "wayland" and _has_command("wl-paste"):
        rc, out, _err = _run(["wl-paste", "--no-newline"], timeout=5, env=env)
    elif _has_command("xclip"):
        rc, out, _err = _run(["xclip", "-selection", "clipboard", "-o"], timeout=5, env=env)
    else:
        return False, "unsupported"
    # Both tools exit non-zero when the selection is empty; that is not an error.
    if rc != 0:
        return True, ""
    return True, out[:CLIPBOARD_MAX]


def _clipboard_write(text):
    """Set the desktop clipboard. (ok, reason)."""
    env = _session_env()
    if SESSION_TYPE == "wayland" and _has_command("wl-copy"):
        cmd = ["wl-copy"]
    elif _has_command("xclip"):
        cmd = ["xclip", "-selection", "clipboard"]
    else:
        return False, "unsupported"
    # Capture nothing: xclip/wl-copy fork a helper to own the selection, and
    # holding their inherited pipes open would block run() until it is replaced.
    try:
        p = subprocess.run(
            cmd, input=text.encode("utf-8"), stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=5, env=env,
        )
        return p.returncode == 0, ("ok" if p.returncode == 0 else "failed")
    except Exception as e:
        return False, str(e)


_CLIP_LAST = {"value": None}

# Last now-playing payload pushed to phones, so the poller only sends changes.
_MEDIA_LAST = {"value": None}


def _clipboard_watcher():
    """Poll the clipboard and push changes to phones. Off unless enabled; the
    phone chooses whether to apply them, so a synced clipboard never silently
    overwrites what is on the other end."""
    while True:
        ok, text = _clipboard_read()
        if ok and text != _CLIP_LAST["value"]:
            _CLIP_LAST["value"] = text
            broadcast_json({"type": "clipboard", "text": text})
        time.sleep(CLIPBOARD_POLL)


# --- Now playing, via MPRIS over the session bus ----------------------------
# The player owns the truth; we only read it. busctl ships with systemd and
# speaks JSON, so the daemon stays stdlib-only and needs no playerctl. Every
# call degrades to "nothing playing" rather than raising, so a laptop with no
# session bus, no player, or an old busctl just shows an idle card.

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
MPRIS_OBJECT = "/org/mpris/MediaPlayer2"
MPRIS_PLAYER = "org.mpris.MediaPlayer2.Player"


def _busctl_json(*args):
    if not _has_command("busctl"):
        return None
    try:
        out = subprocess.run(
            ["busctl", "--user", "--json=short", *args],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3,
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout.decode("utf-8", errors="replace") or "null")
    except Exception:
        return None


def _mpris_players():
    listing = _busctl_json("list")
    if not isinstance(listing, list):
        return []
    names = [row.get("name", "") for row in listing if isinstance(row, dict)]
    return sorted({n for n in names if isinstance(n, str) and n.startswith(MPRIS_PREFIX)})


def _mpris_property(dest, prop):
    node = _busctl_json("get-property", dest, MPRIS_OBJECT, MPRIS_PLAYER, prop)
    if isinstance(node, dict) and "data" in node:
        return node["data"]
    return None


def _mpris_variant(value):
    """Unwrap one busctl JSON variant ({'type':..,'data':..}) to its value."""
    if isinstance(value, dict) and "data" in value:
        return value["data"]
    return value


def _mpris_text(value):
    """MPRIS puts artists in a list and titles in a plain string; take either."""
    if isinstance(value, list):
        return value[0] if value and isinstance(value[0], str) else ""
    return value if isinstance(value, str) else ""


def now_playing():
    """The laptop's current track: the player that is actually 'Playing', else
    the first one found. {'active': False} when there is nothing to read."""
    players = _mpris_players()
    if not players:
        return {"active": False}
    chosen, chosen_status = players[0], None
    for dest in players:
        status = _mpris_property(dest, "PlaybackStatus")
        if status == "Playing":
            chosen, chosen_status = dest, status
            break
        if chosen_status is None:
            chosen, chosen_status = dest, status
    raw_meta = _mpris_property(chosen, "Metadata")
    if not isinstance(raw_meta, dict):
        raw_meta = {}
    meta = {key: _mpris_variant(value) for key, value in raw_meta.items()}
    position = _mpris_property(chosen, "Position")
    length_us = meta.get("mpris:length")
    return {
        "active": True,
        "player": chosen[len(MPRIS_PREFIX):],
        "status": chosen_status or "Stopped",
        "title": _mpris_text(meta.get("xesam:title")),
        "artist": _mpris_text(meta.get("xesam:artist")),
        "album": _mpris_text(meta.get("xesam:album")),
        "lengthMs": int(length_us / 1000) if isinstance(length_us, (int, float)) else 0,
        "positionMs": int(position / 1000) if isinstance(position, (int, float)) else 0,
    }


def _media_watcher():
    """Push now-playing changes to phones; silent while nothing moves."""
    while True:
        try:
            payload = now_playing()
            if payload != _MEDIA_LAST["value"]:
                _MEDIA_LAST["value"] = payload
                broadcast_json({"type": "media_now", **payload})
        except Exception:
            pass
        time.sleep(MEDIA_POLL)


def _query(target):
    """First value of each query-string parameter, e.g. {'path': 'a/b.png'}."""
    parsed = urllib.parse.parse_qs(urllib.parse.urlparse(target).query)
    return {k: v[0] for k, v in parsed.items() if v}


def _safe_rel_path(rel):
    """Validate a share-relative path. Rejects absolute paths, '..' segments and
    dotfiles; returns the normalized 'a/b/c' or None."""
    parts = urllib.parse.unquote(rel or "").strip().strip("/").split("/")
    out = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == ".." or part.startswith("."):
            return None
        out.append(part)
    return "/".join(out) if out else None


def _share_path(rel):
    """Absolute path inside SHARE_DIR for a relative path, or None if unsafe."""
    safe = _safe_rel_path(rel)
    if safe is None:
        return None
    root = os.path.abspath(SHARE_DIR)
    full = os.path.abspath(os.path.join(root, safe))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


def _list_files(rel_dir=""):
    """List one directory in the share. Dir entries first, then files. None on
    an unsafe or missing path."""
    root = os.path.abspath(SHARE_DIR)
    if rel_dir:
        base = _share_path(rel_dir)
        if base is None or not os.path.isdir(base):
            return None
    else:
        base = root
        if not os.path.isdir(base):
            return []  # share not created yet -- nothing uploaded
    try:
        names = os.listdir(base)
    except Exception:
        return None
    entries = []
    for name in names:
        if name.startswith("."):
            continue
        full = os.path.join(base, name)
        try:
            st = os.stat(full)
        except Exception:
            continue
        entries.append({
            "name": name,
            "path": os.path.relpath(full, root).replace(os.sep, "/"),
            "dir": os.path.isdir(full),
            "size": st.st_size,
            "modified": int(st.st_mtime),
        })
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return entries


# --- CROSS-LAPTOP DRAG ------------------------------------------------------
#
# A real desktop drag cannot cross two X servers by itself: the pointer grab and
# the XDND selection live on the laptop where the drag started. When the phone
# carries the pointer over a screen edge with the button held, it asks the
# source laptop for the payload while the drag is still live, then brokers the
# bytes to the laptop on the other side. These helpers expose only paths under
# the user's home directory; the share sandbox is not widened.


def _drag_home():
    return os.path.realpath(os.path.expanduser("~"))


def _drag_home_path(raw, must_exist=False):
    """Resolve an absolute or home-relative path, refusing anything outside $HOME."""
    text = urllib.parse.unquote(str(raw or "")).strip()
    if not text or "\x00" in text:
        return None
    base = _drag_home()
    full = text if os.path.isabs(text) else os.path.join(base, text)
    real = os.path.realpath(full)
    if real != base and not real.startswith(base + os.sep):
        return None
    if must_exist and not os.path.exists(real):
        return None
    return real


def _drag_entry(full):
    """One file/folder under home, in the same shape as a share entry."""
    try:
        st = os.stat(full)
    except Exception:
        return None
    return {
        "name": os.path.basename(full),
        "path": full,
        "dir": os.path.isdir(full),
        "size": st.st_size,
        "modified": int(st.st_mtime),
    }


def _drag_listing(full_dir):
    """List a directory under home. Returns None for an unsafe/missing path."""
    if not full_dir or not os.path.isdir(full_dir):
        return None
    try:
        names = os.listdir(full_dir)
    except Exception:
        return None
    entries = []
    for name in names:
        if name.startswith("."):
            continue
        # A symlink can point outside $HOME or form a loop; copy the real file
        # only when the drag payload itself resolved it, never by following it
        # while walking a folder.
        child = os.path.join(full_dir, name)
        if os.path.islink(child):
            continue
        safe = _drag_home_path(child, must_exist=True)
        if safe is None:
            continue
        entry = _drag_entry(safe)
        if entry is not None:
            entries.append(entry)
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return entries


def _drag_uri_paths(text):
    """Absolute paths from an RFC 2483 text/uri-list, or plain path lines."""
    paths = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        # Some file managers answer with plain paths instead of URIs.
        if line.lower().startswith("file://"):
            parsed = urllib.parse.urlparse(line)
            if parsed.netloc not in ("", "localhost", socket.gethostname()):
                continue
            candidate = urllib.parse.unquote(parsed.path)
        elif line.startswith(("/", "~")):
            candidate = os.path.expanduser(urllib.parse.unquote(line))
        else:
            continue
        real = _drag_home_path(candidate, must_exist=True)
        if real and real not in paths:
            paths.append(real)
    return paths


def _drag_payload(nudge=False):
    """Read the live XDND / clipboard payload while the user still holds a drag.

    The source application owns the `XdndSelection` during a drag, but many
    toolkits only answer a selection request after XDNDDrop. The reliable nudge
    is the file manager's own copy shortcut: Ctrl+C on the already-selected item
    publishes `text/uri-list` to CLIPBOARD without ending the gesture. It is
    only pressed when the phone explicitly asks (`nudge=1`) for a drag handoff.
    """
    if not _has_command("xclip"):
        return {"ok": False, "error": "xclip is not installed on this laptop"}
    if "x11" not in SESSION_TYPE and not os.environ.get("DISPLAY"):
        return {"ok": False, "error": "file drag capture needs an X11 session"}

    def read_attempts():
        attempts = [
            ("xdnd", ["xclip", "-selection", "XdndSelection", "-t", "text/uri-list", "-o"]),
            ("clipboard", ["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-o"]),
            ("primary", ["xclip", "-selection", "primary", "-t", "text/uri-list", "-o"]),
            ("xdnd", ["xclip", "-selection", "XdndSelection", "-o"]),
            ("clipboard", ["xclip", "-selection", "clipboard", "-o"]),
        ]
        for source, cmd in attempts:
            rc, out, _err = _run(cmd, timeout=1.2, env=_session_env())
            if rc != 0 or not out.strip():
                continue
            paths = _drag_uri_paths(out)
            if not paths:
                continue
            entries = [e for e in (_drag_entry(p) for p in paths) if e is not None]
            if entries:
                return source, paths, entries
        return None

    found = read_attempts()
    if found is None and nudge and _has_command("xdotool"):
        # Ctrl+C goes to the focused drag source; it copies the selected item
        # without needing the XDND drop handshake. Give the file manager a beat
        # to claim CLIPBOARD before reading it back.
        _run(["xdotool", "key", "--clearmodifiers", "ctrl+c"], timeout=2, env=_session_env())
        time.sleep(0.25)
        found = read_attempts()
    if found is not None:
        source, paths, entries = found
        return {"ok": True, "source": source, "paths": paths, "entries": entries}
    return {"ok": True, "source": None, "paths": [], "entries": []}


def _drag_default_target():
    """Home-relative folder a cross-screen drop lands in."""
    home = _drag_home()
    for name in ("Desktop", "Downloads"):
        if os.path.isdir(os.path.join(home, name)):
            return name
    share = os.path.abspath(SHARE_DIR)
    try:
        os.makedirs(share, exist_ok=True)
    except Exception:
        pass
    return os.path.basename(share) or "taildeck-share"


# --- SHARE LINKS ------------------------------------------------------------
#
# A link is a token that reveals one subfolder of SHARE_DIR to whoever holds it,
# until it expires or is revoked. Both the link's own folder and the path a
# visitor asks for are put through the same sandbox, so a link can never climb
# out of the folder it was made for. The landing page is plain HTML with a CSP
# so any browser can use it without the app.


def _load_shares():
    """The links file, or a fresh empty store. Never raises."""
    try:
        with open(SHARES_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("links"), list):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        return {"version": 1, "links": []}
    return {"version": 1, "links": []}


def _save_shares(store):
    """Write the store atomically, owner-only. Caller holds SHARES_LOCK."""
    try:
        os.makedirs(os.path.dirname(SHARES_FILE), exist_ok=True)
        tmp = SHARES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(store, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, SHARES_FILE)
        return True
    except Exception:
        return False


def _share_public(link):
    """The owner-facing view of a link. Includes the token so a link can be
    re-copied later; see plans/safe-share-links.md for why that is acceptable."""
    expires = int(link.get("expires") or 0)
    max_uses = int(link.get("maxUses") or 0)
    uses = int(link.get("uses") or 0)
    revoked = bool(link.get("revoked"))
    expired = bool(expires) and time.time() >= expires
    exhausted = bool(max_uses) and uses >= max_uses
    return {
        "id": link.get("id", ""),
        "label": link.get("label", ""),
        "dir": link.get("dir", ""),
        "write": bool(link.get("write")),
        "created": int(link.get("created") or 0),
        "expires": expires,
        "maxUses": max_uses,
        "uses": uses,
        "revoked": revoked,
        "expired": expired,
        "exhausted": exhausted,
        "active": not (revoked or expired or exhausted),
        "token": link.get("token", ""),
        "path": "/s/" + str(link.get("token", "")),
    }


def _lookup_share(token, store=None):
    """The link with this token, or None. Constant-time on the token compare."""
    if not token or not isinstance(token, str):
        return None
    store = store if store is not None else _load_shares()
    match = None
    for link in store.get("links", []):
        stored = str(link.get("token", ""))
        if len(stored) == len(token) and hmac.compare_digest(stored, token):
            match = link
    return match


def _share_valid(link):
    """True while a link may be used at all: not revoked and not expired. The
    use cap is checked separately, on entry only, so one visit can still browse
    and download after its single entry has been spent."""
    if not link or link.get("revoked"):
        return False
    expires = int(link.get("expires") or 0)
    if expires and time.time() >= expires:
        return False
    return True


def _share_dir(rel):
    """Absolute path for a share-relative *directory*. Unlike _share_path, an
    empty path means the share root itself, which is what a link scoped to the
    whole share (and the browse root) needs. None when the path is unsafe."""
    if not (rel or "").strip().strip("/"):
        root = os.path.abspath(SHARE_DIR)
        return root if os.path.isdir(root) else None
    return _share_path(rel)


def _share_link_dir(link, sub):
    """Absolute path for `sub` inside the link's own folder, or None. Two
    sandboxes deep: the link's dir first, then the visitor's relative path."""
    root = _share_dir(link.get("dir"))
    if root is None:
        return None
    if not (sub or "").strip().strip("/"):
        return root
    inner = _safe_rel_path(sub)
    if inner is None:
        return None
    full = os.path.abspath(os.path.join(root, inner))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


def _consume_share(link):
    """Spend one entry against a link and persist. Returns False if it could not
    be spent (a race lost, or already exhausted)."""
    with SHARES_LOCK:
        store = _load_shares()
        for current in store.get("links", []):
            if current.get("id") != link.get("id"):
                continue
            if not _share_valid(current):
                return False
            max_uses = int(current.get("maxUses") or 0)
            if max_uses:
                used = int(current.get("uses") or 0)
                if used >= max_uses:
                    return False
                current["uses"] = used + 1
            _save_shares(store)
            link["uses"] = current.get("uses", 0)
            return True
    return False


def _share_ttl_clamp(ttl):
    """Normalised ttl in seconds; 0 means never expires. Clamped to 30 days."""
    try:
        ttl = int(ttl or 0)
    except Exception:
        return 0
    if ttl <= 0:
        return 0
    return min(ttl, 30 * 24 * 3600)


def _human_size(n):
    try:
        n = int(n)
    except Exception:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n} {unit}" if unit == "B" else f"{n / 1024:.1f} {unit}"
        n /= 1024.0
    return "?"


def _share_page(token, link, sub, message=""):
    """The recipient's landing page: one folder, download links, maybe upload."""
    import html as _html

    dir_full = _share_link_dir(link, sub)
    entries = None
    if dir_full is not None:
        try:
            names = os.listdir(dir_full)
        except Exception:
            names = None
        if names is not None:
            entries = []
            for name in names:
                if name.startswith("."):
                    continue
                full = os.path.join(dir_full, name)
                try:
                    st = os.stat(full)
                except Exception:
                    continue
                entries.append({
                    "name": name,
                    "dir": os.path.isdir(full),
                    "size": st.st_size,
                    "modified": int(st.st_mtime),
                })
            entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))

    base = (link.get("dir") or "").strip("/")
    inner = _safe_rel_path(sub) or "" if (sub or "").strip("/") else ""
    # Uploads are relative to the link root, not to the share root, so a link
    # scoped to one folder never writes into a sibling of the same name.
    rel_now = inner
    depth_parts = [p for p in inner.split("/") if p]

    def href(rel):
        q = urllib.parse.urlencode({"d": rel}) if rel else ""
        return f"/s/{_html.escape(token)}{'?' + q if q else ''}"

    crumbs = [f'<a href="{href("")}">{_html.escape(base.split("/")[-1] or "Shared folder")}</a>']
    walk = []
    for part in depth_parts:
        walk.append(part)
        crumbs.append(f'<a href="{href("/".join(walk))}">{_html.escape(part)}</a>')

    rows = []
    if entries is None:
        rows.append('<p class="muted">This folder is not available.</p>')
    elif not entries:
        rows.append('<p class="muted">This folder is empty.</p>')
    else:
        if depth_parts:
            parent = "/".join(depth_parts[:-1])
            rows.append(f'<a class="row" href="{href(parent)}"><span class="ic">&#8593;</span>'
                        f'<span class="nm">Up</span></a>')
        for e in entries:
            name = _html.escape(e["name"])
            if e["dir"]:
                child = "/".join(depth_parts + [e["name"]])
                rows.append(f'<a class="row" href="{href(child)}"><span class="ic">&#128193;</span>'
                            f'<span class="nm">{name}</span></a>')
            else:
                child = "/".join(depth_parts + [e["name"]])
                dl = f"/s/{_html.escape(token)}/download?{urllib.parse.urlencode({'d': child})}"
                rows.append(f'<a class="row" href="{dl}" download><span class="ic">&#128196;</span>'
                            f'<span class="nm">{name}</span>'
                            f'<span class="sz">{_human_size(e["size"])}</span></a>')

    upload = ""
    if link.get("write"):
        upload = f"""
<form id="up" class="up">
  <input id="f" type="file" />
  <button type="submit">Upload here</button>
  <span id="st" class="muted"></span>
</form>
<script>
document.getElementById('up').addEventListener('submit', async (ev) => {{
  ev.preventDefault();
  const f = document.getElementById('f').files[0];
  const st = document.getElementById('st');
  if (!f) {{ st.textContent = 'Pick a file first.'; return; }}
  st.textContent = 'Uploading…';
  try {{
    const url = '/s/{_html.escape(token)}/upload?' + new URLSearchParams({{d: {json.dumps(rel_now)}, name: f.name}});
    const res = await fetch(url, {{method: 'POST', headers: {{'Content-Type': 'application/octet-stream'}}, body: f}});
    const data = await res.json();
    st.textContent = data && data.ok ? 'Uploaded.' : 'Upload failed.';
    if (data && data.ok) setTimeout(() => location.reload(), 400);
  }} catch (e) {{
    st.textContent = 'Upload failed.';
  }}
}});
</script>"""

    expiry = "no expiry"
    expires = int(link.get("expires") or 0)
    if expires:
        left = int(expires - time.time())
        expiry = "expires in %dh" % max(0, left // 3600) if left >= 3600 else "expires in %dm" % max(0, left // 60)
    max_uses = int(link.get("maxUses") or 0)
    uses = int(link.get("uses") or 0)
    uses_txt = ""
    if max_uses:
        uses_txt = f" &middot; {max_uses - uses} of {max_uses} use(s) left"

    label = _html.escape(link.get("label") or "")
    title = label or _html.escape(base.split("/")[-1] or "Shared folder")
    banner = f'<p class="note">{_html.escape(message)}</p>' if message else ""

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>{title} &middot; TailDeck share</title>
<style>
:root {{ color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: #020617; color: #e2e8f0;
  font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }}
.wrap {{ max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }}
h1 {{ font-size: 18px; margin: 0 0 2px; }}
.crumbs {{ font-size: 12px; color: #64748b; margin-bottom: 14px; }}
.crumbs a {{ color: #38bdf8; text-decoration: none; }}
.crumbs a + a::before {{ content: " / "; color: #475569; }}
.row {{ display: flex; align-items: center; gap: 10px; padding: 12px;
  background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
  margin-bottom: 8px; color: inherit; text-decoration: none; }}
.row:hover {{ border-color: #334155; }}
.ic {{ width: 22px; text-align: center; }}
.nm {{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }}
.sz {{ color: #64748b; font-size: 12px; }}
.muted {{ color: #64748b; }}
.note {{ background: #082f49; border: 1px solid #0e7490; color: #a5f3fc;
  padding: 10px; border-radius: 10px; }}
.up {{ display: flex; gap: 8px; align-items: center; margin-top: 16px;
  padding-top: 16px; border-top: 1px solid #1e293b; }}
.up button {{ background: #0ea5e9; color: #04121f; border: 0; border-radius: 10px;
  padding: 10px 14px; font-weight: 600; }}
footer {{ margin-top: 24px; color: #475569; font-size: 12px; }}
</style></head>
<body><div class="wrap">
<h1>{title}</h1>
<div class="crumbs">{" &middot; ".join(crumbs)}</div>
{banner}{"".join(rows)}{upload}
<footer>Shared with TailDeck &middot; {expiry}{uses_txt}</footer>
</div></body></html>"""


# --- SCREEN VIEW API --------------------------------------------------------
#
# Read-only view of the X screen: a one-shot JPEG for a thumbnail/refresh, and a
# live MJPEG stream for a continuous feed. Capture is argv-only (ffmpeg x11grab,
# no shell) and size/quality/fps are clamped, so a client cannot ask for an
# absurd frame or an unbounded frame rate.


def _x11_display():
    """The X display ffmpeg should grab, e.g. ':0.0'."""
    disp = os.environ.get("DISPLAY") or _session_env().get("DISPLAY") or ":0"
    if "." not in disp.split(":", 1)[-1]:
        disp += ".0"
    return disp


def _screen_size():
    """Whole-X-screen size (union of all monitors) from xrandr, or None."""
    rc, out, _err = _run(["xrandr", "--query"], timeout=5, env=_session_env())
    if rc != 0:
        return None
    m = re.search(r"current\s+(\d+)\s*x\s*(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _screen_info():
    size = _screen_size()
    if not size:
        return None
    info = {"width": size[0], "height": size[1]}
    if _rdp_supported():
        info["rdpWsPath"] = "/api/rdp/ws"
    return info


def _clamp_width(width):
    if width not in (None, "", 0):
        try:
            w = int(width)
        except Exception:
            w = SCREEN_DEFAULT_WIDTH
    else:
        w = SCREEN_DEFAULT_WIDTH
    w = max(160, min(SCREEN_MAX_WIDTH, w))
    return w - (w % 2)  # ffmpeg scale needs an even width


def _clamp_quality(quality):
    try:
        q = int(quality)
    except Exception:
        return SCREEN_QUALITY
    return max(2, min(31, q))


def _capture_frame(width=None, quality=None):
    """Grab one JPEG of the whole X screen. (ok, bytes_or_reason)."""
    if "x11" not in SESSION_TYPE or not _has_command("ffmpeg"):
        return False, "unsupported"
    cmd = [
        "ffmpeg", "-loglevel", "error", "-f", "x11grab",
        "-i", _x11_display(), "-frames:v", "1",
        "-vf", f"scale={_clamp_width(width)}:-2",
        "-q:v", str(_clamp_quality(quality)), "-f", "mjpeg", "-",
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=10, env=_session_env())
    except Exception as e:
        return False, str(e)
    if res.returncode != 0 or not res.stdout:
        return False, (res.stderr.decode("utf-8", "replace").strip() or "capture failed")[:200]
    return True, res.stdout


def _mjpeg_stream(conn, width=None, fps=None, quality=None):
    """Stream the screen as multipart/x-mixed-replace until the client leaves.

    One long-lived ffmpeg emits concatenated JPEGs on a pipe; we split them on
    the SOI/EOI markers and wrap each in a part. The connection is closed (and
    ffmpeg killed) when the client stops reading.
    """
    if "x11" not in SESSION_TYPE or not _has_command("ffmpeg"):
        _json(conn, {"ok": False, "error": "unsupported"}, "501 Not Implemented")
        return
    try:
        # A peer that stops reading (phone sleeps, Wi-Fi drops) must not pin
        # ffmpeg forever: give up the send and let the finally below reap it.
        conn.settimeout(15)
    except Exception:
        pass
    try:
        fps = float(fps)
    except Exception:
        fps = SCREEN_STREAM_FPS
    fps = max(0.5, min(15.0, fps))
    boundary = "taildeckframe"
    stream_origin = getattr(REQUEST_ORIGIN, "origin", "")
    stream_cors = "Vary: Origin\r\n"
    if stream_origin and _origin_allowed(stream_origin):
        stream_cors += f"Access-Control-Allow-Origin: {stream_origin}\r\n"
    head = (
        f"HTTP/1.1 200 OK\r\n"
        f"Content-Type: multipart/x-mixed-replace; boundary={boundary}\r\n"
        f"Cache-Control: no-cache\r\n"
        f"{stream_cors}"
        f"Connection: close\r\n\r\n"
    )
    cmd = [
        "ffmpeg", "-loglevel", "error", "-f", "x11grab",
        "-framerate", str(fps), "-i", _x11_display(),
        "-vf", f"scale={_clamp_width(width)}:-2",
        "-q:v", str(_clamp_quality(quality)), "-c:v", "mjpeg", "-f", "image2pipe", "-",
    ]
    proc = None
    try:
        conn.sendall(head.encode("utf-8"))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=_session_env())
        sep = b"--" + boundary.encode("utf-8")
        buf = b""
        while True:
            # read1 returns as soon as bytes are available; a plain read(n)
            # would block until n bytes pile up (~40s at low frame rates).
            chunk = proc.stdout.read1(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                start = buf.find(b"\xff\xd8")
                if start < 0:
                    buf = b""
                    break
                end = buf.find(b"\xff\xd9", start + 2)
                if end < 0:
                    buf = buf[start:]
                    break
                frame = buf[start:end + 2]
                buf = buf[end + 2:]
                conn.sendall(
                    sep + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(frame)).encode("utf-8") + b"\r\n\r\n" + frame + b"\r\n"
                )
    except Exception:
        pass
    finally:
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


# --- REMOTE DESKTOP (RFB over WebSocket) ------------------------------------
#
# A managed x11vnc bound to loopback, bridged to the phone through the daemon's
# own WebSocket listener. Riding the existing TLS listener means no extra port
# and no mixed-content problem, and access lands on the same trust boundary the
# daemon already has (it injects input for anyone who can reach it). It does
# expose the whole desktop, though, so it starts explicitly and can be stopped.

VNC_PORT = int(os.environ.get("TAILDECK_VNC_PORT", "5900"))
VNC_DISPLAY = os.environ.get("TAILDECK_VNC_DISPLAY", "")
_VNC = {"proc": None}
_VNC_LOCK = threading.Lock()


def _rdp_supported():
    return "x11" in SESSION_TYPE and _has_command("x11vnc")


def _vnc_running():
    proc = _VNC["proc"]
    return bool(proc and proc.poll() is None)


def _port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except Exception:
        return False


def _vnc_start():
    """Start x11vnc on loopback if it is not already up. (ok, detail)."""
    if not _rdp_supported():
        return False, "unsupported"
    with _VNC_LOCK:
        if _vnc_running():
            return True, "already running"
        cmd = [
            "x11vnc", "-display", VNC_DISPLAY or _x11_display(),
            "-rfbport", str(VNC_PORT), "-localhost",
            "-forever", "-shared", "-nopw", "-quiet",
        ]
        try:
            _VNC["proc"] = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=_session_env(),
            )
        except Exception as e:
            return False, str(e)
        # x11vnc forks/settles before it binds; wait for the port to answer.
        for _ in range(25):
            if not _vnc_running():
                return False, "x11vnc exited"
            if _port_open("127.0.0.1", VNC_PORT):
                print(f"[TailDeck] x11vnc listening on 127.0.0.1:{VNC_PORT}", flush=True)
                return True, "started"
            time.sleep(0.15)
        return _vnc_running(), ("started" if _vnc_running() else "x11vnc exited")


def _vnc_stop():
    """Stop the managed x11vnc, if any. (ok, detail)."""
    with _VNC_LOCK:
        proc = _VNC["proc"]
        _VNC["proc"] = None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
    print("[TailDeck] x11vnc stopped", flush=True)
    return True, "stopped"


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("eof")
        buf += chunk
    return buf


def send_ws_binary(conn, data, opcode=0x2):
    """Send a binary (or given-opcode) WebSocket frame. RFB bytes are opaque."""
    length = len(data)
    header = bytearray([0x80 | opcode])
    if length <= 125:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    with _WS_SEND_LOCK:
        conn.sendall(bytes(header) + data)


def read_ws_raw(conn):
    """Read one WebSocket frame as (opcode, bytes), or None on close/error."""
    try:
        header = _recv_exact(conn, 2)
        opcode = header[0] & 0x0F
        masked = (header[1] & 0x80) != 0
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", _recv_exact(conn, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", _recv_exact(conn, 8))[0]
        mask = _recv_exact(conn, 4) if masked else None
        data = _recv_exact(conn, length) if length else b""
        if masked and data:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return opcode, data
    except Exception:
        return None


def _rdp_proxy(conn):
    """Bridge this WebSocket to a local x11vnc RFB stream until either side
    closes. Client frames are forwarded to VNC; VNC output is framed back."""
    if not _rdp_supported():
        try:
            send_ws_frame(conn, json.dumps({"type": "error", "message": "rdp unsupported"}))
        except Exception:
            pass
        return
    ok, detail = _vnc_start()
    if not ok:
        try:
            send_ws_frame(conn, json.dumps({"type": "error", "message": f"x11vnc: {detail}"}))
        except Exception:
            pass
        return
    try:
        tcp = socket.create_connection(("127.0.0.1", VNC_PORT), timeout=5)
        tcp.settimeout(None)
    except Exception as e:
        print(f"[TailDeck] rdp: cannot reach x11vnc: {e}", flush=True)
        return
    stop = threading.Event()

    def client_to_vnc():
        try:
            while not stop.is_set():
                frame = read_ws_raw(conn)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:                 # close
                    break
                if opcode == 0x9:                 # ping -> pong
                    send_ws_binary(conn, payload, opcode=0xA)
                    continue
                if opcode == 0xA:                 # pong
                    continue
                if opcode in (0x0, 0x1, 0x2):     # continuation/text/binary
                    tcp.sendall(payload)
        except Exception:
            pass
        finally:
            stop.set()

    threading.Thread(target=client_to_vnc, daemon=True).start()
    try:
        while not stop.is_set():
            chunk = tcp.recv(65536)
            if not chunk:
                break
            send_ws_binary(conn, chunk)
    except Exception:
        pass
    finally:
        stop.set()
        try:
            tcp.close()
        except Exception:
            pass
    print("[TailDeck] rdp session closed", flush=True)


def _capabilities():
    """Feature flags reported in host_info so clients can adapt."""
    caps = ["media", "dictation", "scripts", "notify", "apps", "power", "record"]
    if _has_command("xrandr"):
        caps.append("displays")
    # Absolute pointer position; only X11 can be asked, and only via xdotool.
    if SESSION_TYPE == "x11" and _has_command("xdotool"):
        caps.append("pointer")
    if _backlight_device():
        caps.append("brightness")
    if _has_command("xclip") or (SESSION_TYPE == "wayland" and _has_command("wl-paste")):
        caps.append("clipboard")
    caps.append("files")
    if "x11" in SESSION_TYPE and _has_command("ffmpeg") and _screen_size():
        caps.append("screen")
    if _rdp_supported():
        caps.append("rdp")
    return caps


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


def _load_devices():
    """Paired-device store, or a fresh one. Only token hashes are kept."""
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("devices"), list):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return {"version": 1, "devices": []}


def _save_devices(store):
    try:
        os.makedirs(os.path.dirname(DEVICES_FILE), exist_ok=True)
        tmp = DEVICES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(store, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, DEVICES_FILE)
        return True
    except Exception as e:
        print(f"[TailDeck] could not save devices: {e}", flush=True)
        return False


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _device_token_ok(token):
    """Constant-time check against the env override or a paired device hash."""
    if not token or not isinstance(token, str):
        return False
    if DEVICE_TOKEN_ENV:
        return hmac.compare_digest(token, DEVICE_TOKEN_ENV)
    digest = _token_hash(token)
    now = int(time.time())
    with DEVICES_LOCK:
        store = _load_devices()
        for dev in store.get("devices", []):
            if dev.get("revoked"):
                continue
            stored = str(dev.get("tokenHash") or "")
            if stored and hmac.compare_digest(digest, stored):
                dev["lastSeen"] = now
                # Persist at most once a minute per device; the in-memory
                # update keeps this request's answer correct either way.
                dev_id = str(dev.get("id") or "")
                if now - _LAST_SEEN_SAVED.get(dev_id, 0) >= 60:
                    _LAST_SEEN_SAVED[dev_id] = now
                    _save_devices(store)
                return True
    return False


def _session_token(headers):
    """Bearer token from an HTTP request, or '' when absent/malformed."""
    value = headers.get("authorization", "")
    if not value.lower().startswith("bearer "):
        return ""
    return value[7:].strip()


def _request_is_local(conn, headers):
    """The laptop's own browser. Never true for a request that came through a
    reverse proxy, even though the proxy connects from loopback.

    A browser Origin is checked too: without that, any website open on the
    laptop could drive ws://127.0.0.1 (a loopback peer alone cannot tell the
    laptop's own page from a page it happens to be visiting)."""
    if headers.get("x-forwarded-for"):
        return False
    origin = headers.get("origin", "")
    if origin and not _origin_allowed(origin):
        return False
    return _peer_is_loopback(conn)


def _mint_device(label):
    """Create a per-phone token. Only the hash is persisted; return plaintext once."""
    token = secrets.token_urlsafe(32)
    dev = {
        "id": secrets.token_hex(8),
        "label": (str(label or "phone").strip() or "phone")[:64],
        "tokenHash": _token_hash(token),
        "created": int(time.time()),
        "lastSeen": int(time.time()),
        "revoked": False,
    }
    with DEVICES_LOCK:
        store = _load_devices()
        store.setdefault("devices", []).append(dev)
        if not _save_devices(store):
            return None, None
    return dev["id"], token


def _mint_pair_code(label):
    now = time.time()
    code = secrets.token_urlsafe(12)
    with PAIRING_LOCK:
        for key, rec in list(PAIRING_PENDING.items()):
            if now - rec["created"] > PAIRING_TTL * 2:
                PAIRING_PENDING.pop(key, None)
        PAIRING_PENDING[_token_hash(code)] = {
            "created": now,
            "label": (str(label or "phone").strip() or "phone")[:64],
        }
    return code, int(now + PAIRING_TTL)


def _consume_pair_code(code):
    """Spend a pairing code. Returns its label, or None when invalid/expired."""
    if not code or not isinstance(code, str):
        return None
    key = _token_hash(code)
    now = time.time()
    with PAIRING_LOCK:
        rec = PAIRING_PENDING.pop(key, None)
    if not rec:
        return None
    if now - rec["created"] > PAIRING_TTL:
        return None
    return rec["label"]


def _origin_allowed(origin):
    """Echo an Origin only when it is one of the app's own surfaces.

    Recomputing interface addresses is not free, so cache briefly. The set is
    intentionally explicit: wildcard CORS is what let any visited website drive
    this daemon.
    """
    if not origin:
        return False
    now = time.time()
    cache = ALLOWED_ORIGINS_CACHE
    if now - cache["at"] > 30:
        allowed = set(ALLOWED_ORIGINS_ENV)
        allowed.add("https://phy6.github.io")
        for port in (PORT, TLS_PORT):
            for host in ("localhost", "127.0.0.1", "[::1]"):
                allowed.add(f"http://{host}:{port}")
                allowed.add(f"https://{host}:{port}")
        for host in ("localhost", "127.0.0.1"):
            allowed.add(f"http://{host}:3000")
        try:
            for item in usable_interfaces():
                ip = item.get("address")
                if ip:
                    allowed.add(f"http://{ip}:{PORT}")
                    allowed.add(f"https://{ip}:{TLS_PORT}")
            tailnet = tailnet_dns_name()
            if tailnet:
                allowed.add(f"https://{tailnet}")
        except Exception:
            pass
        cache["items"] = allowed
        cache["at"] = now
    return origin.rstrip("/") in cache["items"]


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


def _version_key(value):
    """Numeric parts of a version, so 1.11.0 counts as newer than 1.7.0.

    The release channel can lag a local build. Comparing by inequality would
    advertise a "downgrade" in that case; only a strictly newer release is an
    update.
    """
    return tuple(int(part) for part in re.findall(r"\d+", value or ""))


def _has_newer_release(latest, current):
    return bool(latest) and _version_key(latest) > _version_key(current)


def _installed_app_version():
    """The app version currently published in WEBROOT, if it can be read."""
    try:
        with open(os.path.join(WEBROOT, "version.json"), encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("app")
    except Exception:
        return None


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

    # Only move forward. The published channel can lag a local build (a laptop
    # running ahead of Pages), and a release with neither half newer would turn
    # "update" into a downgrade.
    current_app = _installed_app_version()
    if not (
        _has_newer_release(target_daemon, DAEMON_VERSION)
        or _has_newer_release(target_app, current_app)
    ):
        report["upToDate"] = True
        report["steps"].append(
            f"already up to date (daemon {DAEMON_VERSION}, app {current_app or 'unknown'})"
        )
        return True, report

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


# Sessions for one-visit links: opening the landing page spends an entry and
# leaves a cookie, so browsing and downloading within that visit do not spend
# more. In-memory only -- a restart invalidates live visits.
_SHARE_SESSIONS = {}
_SHARE_SESSIONS_LOCK = threading.Lock()
_SHARE_SESSION_CAP = 500


def _share_session_ok(token, sid):
    if not sid:
        return False
    with _SHARE_SESSIONS_LOCK:
        return sid in _SHARE_SESSIONS.get(token, ())


def _share_session_new(token):
    sid = secrets.token_urlsafe(16)
    with _SHARE_SESSIONS_LOCK:
        if len(_SHARE_SESSIONS) > _SHARE_SESSION_CAP:
            _SHARE_SESSIONS.clear()
        _SHARE_SESSIONS.setdefault(token, set()).add(sid)
    return sid


def _share_cookie_sid(headers):
    for part in (headers.get("cookie") or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == "tds":
            return value.strip()
    return ""


def _share_send(conn, status, html, cookie=""):
    extra = "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
    extra += "script-src 'unsafe-inline'; connect-src 'self'\r\n"
    extra += "X-Content-Type-Options: nosniff\r\n"
    if cookie:
        extra += f"Set-Cookie: {cookie}\r\n"
    _http(conn, status, "text/html; charset=utf-8", html.encode("utf-8"), "no-store", extra=extra)


def _share_missing(conn):
    """One opaque answer for unknown, expired, revoked and used-up links."""
    _share_send(conn, "404 Not Found", (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" />"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />"
        "<title>Not found</title></head><body style=\"background:#020617;color:#e2e8f0;"
        "font:15px system-ui;padding:40px;\">"
        "<h1 style=\"font-size:18px\">This link is not available</h1>"
        "<p style=\"color:#64748b\">It may have expired, been used, or been revoked.</p>"
        "</body></html>"))


def handle_share_request(conn, raw, request_line):
    """Answer /s/<token>... for link visitors. Returns True when it handled the
    request, so the caller does not fall through to static file serving."""
    try:
        parts = request_line.split()
        method = parts[0].upper()
        target = parts[1]
    except Exception:
        return False
    path = target.split("?", 1)[0]
    if path != "/s" and not path.startswith("/s/"):
        return False

    rest = path[len("/s/"):] if path.startswith("/s/") else ""
    head, _, action = rest.partition("/")
    token = urllib.parse.unquote(head)

    headers = _parse_headers(raw.decode("utf-8", errors="ignore"))
    query = _query(target)
    sub = query.get("d", "")

    link = _lookup_share(token)
    if not _share_valid(link):
        _share_missing(conn)
        return True

    sid = _share_cookie_sid(headers)

    if action == "" and method == "GET":
        if not _share_session_ok(token, sid):
            if not _consume_share(link):
                _share_missing(conn)
                return True
            sid = _share_session_new(token)
        cookie = f"tds={sid}; Path=/s/{token}; HttpOnly; SameSite=Lax; Max-Age=86400"
        _share_send(conn, "200 OK", _share_page(token, link, sub), cookie=cookie)
        return True

    # Everything else needs the cookie the landing page handed out, so a copied
    # download URL does not outlive the visit that created it.
    if not _share_session_ok(token, sid):
        _share_missing(conn)
        return True

    if action == "download" and method == "GET":
        full = _share_link_dir(link, sub)
        if full is None or not os.path.isfile(full):
            _share_missing(conn)
            return True
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except Exception:
            _http(conn, "500 Internal Server Error", "text/plain; charset=utf-8",
                  b"Unreadable\n")
            return True
        ctype = MIME_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        filename = os.path.basename(full).replace('"', "").replace("\\", "")
        _http(conn, "200 OK", ctype, data, "no-store",
              extra=f'Content-Disposition: attachment; filename="{filename}"\r\n')
        return True

    if action == "upload" and method == "POST":
        if not link.get("write"):
            _json(conn, {"ok": False, "error": "read-only link"}, "403 Forbidden")
            return True
        name = (query.get("name") or "").strip()
        clean = name.replace("/", "").replace("\\", "").strip()
        if not clean or clean.startswith("."):
            _json(conn, {"ok": False, "error": "bad name"}, "400 Bad Request")
            return True
        parent = _share_link_dir(link, sub)
        if parent is None:
            _json(conn, {"ok": False, "error": "bad path"}, "400 Bad Request")
            return True
        full = os.path.join(parent, clean)
        data = _read_http_body(conn, raw, headers)
        if len(data) > MAX_UPLOAD:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        try:
            os.makedirs(parent, exist_ok=True)
            with open(full, "wb") as fh:
                fh.write(data)
        except Exception:
            _json(conn, {"ok": False, "error": "unwritable"}, "500 Internal Server Error")
            return True
        _json(conn, {"ok": True, "name": clean, "size": len(data)})
        return True

    _share_missing(conn)
    return True


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

    if handle_share_request(conn, raw, request_line):
        return True

    if not path.startswith("/api/"):
        return False

    if method == "OPTIONS":
        _http(conn, "204 No Content", "text/plain; charset=utf-8", b"")
        return True

    headers = _parse_headers(raw.decode("utf-8", errors="ignore"))

    # Identity endpoints stay readable so a phone can discover a laptop before
    # it has paired; everything else is token-gated. Loopback (the laptop's own
    # browser) is trusted because a local process can already drive the input
    # devices; proxied requests never count as local.
    local = _request_is_local(conn, headers)
    authed = local or _device_token_ok(_session_token(headers))
    if path not in ("/api/beacon", "/api/version") and not authed:
        _json(conn, {
            "ok": False,
            "error": "pairing required",
            "code": "unauthorized",
        }, "401 Unauthorized")
        return True

    if path == "/api/pair/new" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        code, expires = _mint_pair_code(data.get("label"))
        _json(conn, {"ok": True, "code": code, "expires": expires})
        return True

    if path.rstrip("/") == "/api/devices" and method == "GET":
        _json(conn, {"ok": True, "devices": [
            {
                "id": d.get("id"),
                "label": d.get("label"),
                "created": d.get("created"),
                "lastSeen": d.get("lastSeen"),
                "revoked": bool(d.get("revoked")),
            }
            for d in _load_devices().get("devices", [])
        ]})
        return True

    if path.startswith("/api/devices/") and method == "DELETE":
        dev_id = urllib.parse.unquote(path[len("/api/devices/"):]).strip()
        with DEVICES_LOCK:
            store = _load_devices()
            found = False
            for dev in store.get("devices", []):
                if dev.get("id") == dev_id:
                    dev["revoked"] = True
                    found = True
            if found:
                _save_devices(store)
        if not found:
            _json(conn, {"ok": False, "error": "not found"}, "404 Not Found")
            return True
        _json(conn, {"ok": True})
        return True

    if path == "/api/media/now" and method == "GET":
        _json(conn, now_playing())
        return True

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
            "updateAvailable": _has_newer_release((latest or {}).get("daemon"), DAEMON_VERSION),
        })
        return True

    # HTTPS fallback for discovery: a browser cannot hear a UDP beacon, but it
    # can ask a remembered host who it is and whether its certificate still
    # matches.
    if path == "/api/beacon" and method == "GET":
        _json(conn, {"ok": True, **discovery_payload()})
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

    if path == "/api/apps" and method == "GET":
        apps = _list_apps()
        _json(conn, {"ok": True, "count": len(apps), "apps": [
            {k: a[k] for k in ("id", "name", "comment", "categories", "icon", "iconVersion")}
            for a in apps
        ]})
        return True

    if path == "/api/apps/icon" and method == "GET":
        query = urllib.parse.parse_qs(target.split("?", 1)[1]) if "?" in target else {}
        app_id = (query.get("id") or [""])[0]
        hit = _find_app(app_id)
        icon = _resolve_icon(hit[1].get("Icon", "")) if hit else None
        if not icon:
            _http(conn, "404 Not Found", "text/plain; charset=utf-8", b"no icon\n")
            return True
        ctype = MIME_TYPES.get(os.path.splitext(icon)[1].lower(), "application/octet-stream")
        try:
            with open(icon, "rb") as fh:
                body = fh.read()
        except Exception:
            _http(conn, "500 Internal Server Error", "text/plain; charset=utf-8", b"unreadable\n")
            return True
        # The client puts the file's version in the URL, so a changed icon is a
        # different URL and this copy can be cached hard.
        _http(conn, "200 OK", ctype, body, cache="public, max-age=31536000, immutable")
        return True

    if path == "/api/apps/launch" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        ok, detail = _launch_app(str(data.get("id") or ""))
        if ok:
            print(f"[TailDeck] launched app: {data.get('id')} ({detail})", flush=True)
        _json(conn, {"ok": ok, "detail": detail}, "200 OK" if ok else "400 Bad Request")
        return True

    if path == "/api/windows" and method == "GET":
        _json(conn, {"ok": True, **_list_windows()})
        return True

    if path == "/api/windows/focus" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        wid = str(data.get("id") or "").strip()
        match = str(data.get("match") or "").strip()
        if not wid and not match:
            _json(conn, {"ok": False, "error": "id or match required"}, "400 Bad Request")
            return True
        ok, detail = _focus_window_id(wid) if wid else _focus_window(match)
        _json(conn, {"ok": ok, "detail": detail}, "200 OK" if ok else "409 Conflict")
        return True

    if path == "/api/power" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        action = str(data.get("action") or "")
        ok, detail = _power_action(action, data.get("value"))
        print(f"[TailDeck] power {action}: ok={ok} ({detail})", flush=True)
        _json(conn, {"ok": ok, "action": action, "detail": detail,
                     "brightness": _brightness_pct()},
              "200 OK" if ok else "400 Bad Request")
        return True

    if path == "/api/displays" and method == "GET":
        _json(conn, {"ok": True, "displays": _displays()})
        return True

    # Which monitor the pointer is on. The spatial layout is phone-side, so only
    # the daemon can answer "is that laptop's edge the one the pointer is at?".
    if path == "/api/pointer" and method == "GET":
        pointer = _pointer_location()
        if pointer is None:
            _json(conn, {"ok": False, "error": "unsupported"}, "501 Not Implemented")
            return True
        _json(conn, {"ok": True, "pointer": pointer})
        return True

    if path == "/api/displays" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        outputs = data.get("outputs")
        if isinstance(outputs, list):
            ok, detail = _set_display_layout(outputs)
        elif data.get("output"):
            # Keep the old `{output, mode}` call working; any layout field routes
            # to the move/rotate path.
            layout_fields = ("x", "y", "rotation", "reflect", "primary")
            if "mode" in data and not any(field in data for field in layout_fields):
                ok, detail = _set_display_mode(str(data.get("output")), str(data.get("mode") or ""))
            else:
                ok, detail = _set_display_layout([data])
        else:
            ok, detail = False, "output or outputs required"
        # Return the refreshed geometry so the editor can redraw from truth.
        _json(conn, {"ok": ok, "detail": detail, "displays": _displays()},
              "200 OK" if ok else "400 Bad Request")
        return True

    if path == "/api/clipboard" and method == "GET":
        ok, text = _clipboard_read()
        if not ok:
            _json(conn, {"ok": False, "error": text}, "501 Not Implemented")
            return True
        _json(conn, {"ok": True, "text": text})
        return True

    if path == "/api/clipboard" and method in ("POST", "PUT"):
        body = _read_http_body(conn, raw, headers)
        try:
            data = json.loads(body.decode("utf-8", errors="replace") or "{}")
        except Exception:
            data = {}
        text = str(data.get("text") or "")
        if len(text.encode("utf-8")) > CLIPBOARD_MAX:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        ok, detail = _clipboard_write(text)
        _json(conn, {"ok": ok, "detail": detail},
              "200 OK" if ok else "500 Internal Server Error")
        return True

    if path == "/api/files" and method == "GET":
        rel = _query(target).get("dir", "")
        entries = _list_files(rel)
        if entries is None:
            _json(conn, {"ok": False, "error": "bad path"}, "400 Bad Request")
            return True
        _json(conn, {"ok": True, "dir": rel.strip("/"), "entries": entries})
        return True

    if path == "/api/files/download" and method == "GET":
        full = _share_path(_query(target).get("path", ""))
        if full is None or not os.path.isfile(full):
            _json(conn, {"ok": False, "error": "not found"}, "404 Not Found")
            return True
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except Exception:
            _json(conn, {"ok": False, "error": "unreadable"}, "500 Internal Server Error")
            return True
        ctype = MIME_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        filename = os.path.basename(full).replace('"', "").replace("\\", "")
        _http(conn, "200 OK", ctype, data, "no-cache",
              extra=f'Content-Disposition: attachment; filename="{filename}"\r\n')
        return True

    if path == "/api/files/upload" and method in ("POST", "PUT"):
        rel = _query(target).get("path", "")
        full = _share_path(rel)
        if full is None:
            _json(conn, {"ok": False, "error": "bad path"}, "400 Bad Request")
            return True
        try:
            declared = int(headers.get("content-length", "0") or "0")
        except Exception:
            declared = 0
        if declared > MAX_UPLOAD:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        data = _read_http_body(conn, raw, headers)
        if len(data) > MAX_UPLOAD:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        try:
            parent = os.path.dirname(full)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(full, "wb") as fh:
                fh.write(data)
        except Exception:
            _json(conn, {"ok": False, "error": "unwritable"}, "500 Internal Server Error")
            return True
        print(f"[TailDeck] file saved: {rel} ({len(data)} bytes)", flush=True)
        _json(conn, {"ok": True, "path": rel.strip("/"), "size": len(data)})
        return True

    # Cross-laptop drag: the phone captures the live drag payload here, then
    # streams it into the destination laptop under its home folder.
    if path == "/api/drag/payload" and method == "GET":
        _json(conn, _drag_payload(nudge=_query(target).get("nudge") == "1"))
        return True

    if path == "/api/drag/info" and method == "GET":
        _json(conn, {
            "ok": True,
            "home": _drag_home(),
            "targetDir": _drag_default_target(),
        })
        return True

    if path == "/api/drag/list" and method == "GET":
        full = _drag_home_path(_query(target).get("path", ""), must_exist=True)
        entries = _drag_listing(full) if full else None
        if entries is None:
            _json(conn, {"ok": False, "error": "bad or missing path"}, "400 Bad Request")
            return True
        _json(conn, {"ok": True, "dir": full, "entries": entries})
        return True

    if path == "/api/drag/download" and method == "GET":
        full = _drag_home_path(_query(target).get("path", ""), must_exist=True)
        if full is None or not os.path.isfile(full):
            _json(conn, {"ok": False, "error": "not found"}, "404 Not Found")
            return True
        try:
            if os.path.getsize(full) > MAX_UPLOAD:
                _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
                return True
            with open(full, "rb") as fh:
                data = fh.read()
        except Exception:
            _json(conn, {"ok": False, "error": "unreadable"}, "500 Internal Server Error")
            return True
        ctype = MIME_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        filename = os.path.basename(full).replace('"', "").replace("\\", "")
        _http(conn, "200 OK", ctype, data, "no-cache",
              extra=f'Content-Disposition: attachment; filename="{filename}"\r\n')
        return True

    if path == "/api/drag/upload" and method in ("POST", "PUT"):
        rel_dir = _query(target).get("dir", "")
        name = urllib.parse.unquote(_query(target).get("name", "")).strip()
        if not name or name in (".", "..") or "/" in name or "\\" in name or name.startswith("."):
            _json(conn, {"ok": False, "error": "bad name"}, "400 Bad Request")
            return True
        dir_full = _drag_home_path(rel_dir)
        if dir_full is None:
            _json(conn, {"ok": False, "error": "bad directory"}, "400 Bad Request")
            return True
        full = _drag_home_path(os.path.join(dir_full, name))
        if full is None:
            _json(conn, {"ok": False, "error": "bad path"}, "400 Bad Request")
            return True
        try:
            declared = int(headers.get("content-length", "0") or "0")
        except Exception:
            declared = 0
        if declared > MAX_UPLOAD:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        data = _read_http_body(conn, raw, headers)
        if len(data) > MAX_UPLOAD:
            _json(conn, {"ok": False, "error": "too large"}, "413 Payload Too Large")
            return True
        try:
            os.makedirs(dir_full, exist_ok=True)
            with open(full, "wb") as fh:
                fh.write(data)
        except Exception:
            _json(conn, {"ok": False, "error": "unwritable"}, "500 Internal Server Error")
            return True
        print(f"[TailDeck] drag drop: {os.path.relpath(full, _drag_home())} ({len(data)} bytes)", flush=True)
        _json(conn, {"ok": True, "path": full, "size": len(data)})
        return True

    if path == "/api/drag/mkdir" and method in ("POST", "PUT"):
        rel_dir = _query(target).get("dir", "")
        full = _drag_home_path(rel_dir)
        if full is None:
            _json(conn, {"ok": False, "error": "bad directory"}, "400 Bad Request")
            return True
        try:
            os.makedirs(full, exist_ok=True)
        except Exception:
            _json(conn, {"ok": False, "error": "unwritable"}, "500 Internal Server Error")
            return True
        _json(conn, {"ok": True, "path": full})
        return True

    if path.rstrip("/") == "/api/shares" and method == "GET":
        store = _load_shares()
        _json(conn, {"ok": True,
                     "shares": [_share_public(l) for l in store.get("links", [])]})
        return True

    if path.rstrip("/") == "/api/shares" and method == "POST":
        q = _query(target)
        raw_dir = q.get("dir", "") or ""
        dir_rel = _safe_rel_path(raw_dir)
        if dir_rel is None and raw_dir.strip("/"):
            _json(conn, {"ok": False, "error": "bad path"}, "400 Bad Request")
            return True
        dir_rel = dir_rel or ""
        root = _share_dir(dir_rel)
        if root is None or not os.path.isdir(root):
            _json(conn, {"ok": False, "error": "no such folder"}, "400 Bad Request")
            return True
        ttl = _share_ttl_clamp(q.get("ttl"))
        try:
            max_uses = max(0, min(int(q.get("maxUses") or 0), 10000))
        except Exception:
            max_uses = 0
        link = {
            "id": secrets.token_hex(8),
            "label": (q.get("label") or "").strip()[:80],
            "token": secrets.token_urlsafe(32),
            "dir": dir_rel,
            "write": q.get("write", "") in ("1", "true", "yes"),
            "created": int(time.time()),
            "expires": (int(time.time()) + ttl) if ttl else 0,
            "maxUses": max_uses,
            "uses": 0,
            "revoked": False,
        }
        with SHARES_LOCK:
            store = _load_shares()
            store.setdefault("links", []).append(link)
            saved = _save_shares(store)
        if not saved:
            _json(conn, {"ok": False, "error": "could not save"}, "500 Internal Server Error")
            return True
        print(f"[TailDeck] share link created for {dir_rel or '<share root>'}"
              f" (write={link['write']}, ttl={ttl}, maxUses={max_uses})", flush=True)
        _json(conn, {"ok": True, "share": _share_public(link)})
        return True

    if path.startswith("/api/shares/"):
        rest = path[len("/api/shares/"):]
        share_id, _, action = rest.partition("/")
        share_id = urllib.parse.unquote(share_id)
        with SHARES_LOCK:
            store = _load_shares()
            link = next((l for l in store.get("links", []) if l.get("id") == share_id), None)
            if link is None:
                _json(conn, {"ok": False, "error": "no such link"}, "404 Not Found")
                return True
            if action == "renew" and method == "POST":
                ttl = _share_ttl_clamp(_query(target).get("ttl"))
                link["expires"] = (int(time.time()) + ttl) if ttl else 0
                _save_shares(store)
                _json(conn, {"ok": True, "share": _share_public(link)})
                return True
            if action == "revoke" and method == "POST":
                # Revoke is final: delete the link to hand out a new one. Live
                # visits lose access immediately.
                link["revoked"] = True
                _save_shares(store)
                _SHARE_SESSIONS.pop(str(link.get("token")), None)
                _json(conn, {"ok": True, "share": _share_public(link)})
                return True
            if action == "delete" and method == "POST":
                store["links"] = [l for l in store.get("links", []) if l.get("id") != share_id]
                _save_shares(store)
                _SHARE_SESSIONS.pop(str(link.get("token")), None)
                _json(conn, {"ok": True})
                return True
        _json(conn, {"ok": False, "error": "bad action"}, "400 Bad Request")
        return True

    if path == "/api/screen/frame" and method == "GET":
        q = _query(target)
        ok, data = _capture_frame(q.get("scale") or q.get("width"), q.get("quality"))
        if not ok:
            code = "501 Not Implemented" if data == "unsupported" else "500 Internal Server Error"
            _json(conn, {"ok": False, "error": data}, code)
            return True
        _http(conn, "200 OK", "image/jpeg", data, "no-cache")
        return True

    if path == "/api/screen/stream" and method == "GET":
        q = _query(target)
        _mjpeg_stream(conn, q.get("scale") or q.get("width"), q.get("fps"), q.get("quality"))
        return True

    if path == "/api/rdp/status" and method == "GET":
        _json(conn, {
            "ok": True,
            "supported": _rdp_supported(),
            "running": _vnc_running(),
            "wsPath": "/api/rdp/ws",
        })
        return True

    if path == "/api/rdp/start" and method in ("POST", "PUT"):
        ok, detail = _vnc_start()
        code = "200 OK" if ok else ("501 Not Implemented" if detail == "unsupported" else "500 Internal Server Error")
        _json(conn, {"ok": ok, "detail": detail, "running": _vnc_running(),
                     "wsPath": "/api/rdp/ws"}, code)
        return True

    if path == "/api/rdp/stop" and method in ("POST", "PUT"):
        ok, detail = _vnc_stop()
        _json(conn, {"ok": ok, "detail": detail, "running": _vnc_running()})
        return True

    _json(conn, {"ok": False, "error": "unknown endpoint"}, "404 Not Found")
    return True


# --------------------------------------------------------------------------
# Identity and discovery
#
# The phone decides where it connects. This side only advertises itself: a
# stable device id, the interfaces it is actually reachable on, the ports, and
# the fingerprint of its leaf certificate. The phone builds candidates from
# those announcements instead of trusting a remembered IP.
# --------------------------------------------------------------------------

BEACON_PORT = int(os.environ.get("TAILDECK_BEACON_PORT", 47823))
BEACON_GROUP = "239.255.73.68"
BEACON_INTERVAL = float(os.environ.get("TAILDECK_BEACON_INTERVAL", 3.0))

# Interfaces that exist on the laptop but cannot be reached from a phone.
_VIRTUAL_IFACE = re.compile(
    r"^(lo|docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|dummy|sit|bond|team)"
)
_WIFI_IFACE = re.compile(r"^(wl|wlan|wifi)")
_USB_IFACE = re.compile(r"^(usb|rndis|enx)")
_BT_IFACE = re.compile(r"^(bnep|bt-pan)")
_ETH_IFACE = re.compile(r"^(en|eth)")

SIOCGIFADDR = 0x8915
SIOCGIFNETMASK = 0x891B
SO_BINDTODEVICE = getattr(socket, "SO_BINDTODEVICE", 25)


def _iface_ipv4(name):
    """IPv4 address and netmask of one interface, without third-party modules."""
    try:
        import fcntl

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            req = struct.pack("256s", name[:15].encode("utf-8"))
            addr = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), SIOCGIFADDR, req)[20:24])
            mask = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), SIOCGIFNETMASK, req)[20:24])
        finally:
            sock.close()
        return addr, mask
    except Exception:
        return None


def _transport_for(name):
    if _WIFI_IFACE.match(name):
        return "wifi"
    if _USB_IFACE.match(name):
        return "usb"
    if _BT_IFACE.match(name):
        return "bluetooth"
    if _ETH_IFACE.match(name):
        return "ethernet"
    return "network"


def _broadcast_for(address, netmask):
    try:
        ip = struct.unpack("!I", socket.inet_aton(address))[0]
        mask = struct.unpack("!I", socket.inet_aton(netmask))[0]
        return socket.inet_ntoa(struct.pack("!I", ip | (~mask & 0xFFFFFFFF)))
    except Exception:
        return None


def usable_interfaces():
    """Interfaces a phone can plausibly reach, with their transport kind.

    Link-local, loopback, container bridges and VPN/tunnel devices are excluded:
    advertising those was sending phones to 172.17.0.1 and friends.
    """
    found = []
    try:
        names = socket.if_nameindex()
    except Exception:
        names = []
    for _, name in names:
        if _VIRTUAL_IFACE.match(name):
            continue
        got = _iface_ipv4(name)
        if not got:
            continue
        address, netmask = got
        if address.startswith("127.") or address.startswith("169.254."):
            continue
        found.append({
            "interface": name,
            "address": address,
            "netmask": netmask,
            "broadcast": _broadcast_for(address, netmask),
            "transport": _transport_for(name),
        })
    return sorted(found, key=lambda item: (item["transport"], item["interface"]))


def local_ipv4_addresses():
    """Addresses a phone on the same hotspot could reach the laptop on."""
    return [item["address"] for item in usable_interfaces()]


DEVICE_ID_FILE = os.path.join(os.path.dirname(CONNECTION_LOG), "device-id")


def device_id():
    """A stable id for this laptop, independent of its address or hostname."""
    try:
        with open(DEVICE_ID_FILE, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
            if value:
                return value
    except Exception:
        pass
    value = secrets.token_hex(8)
    try:
        os.makedirs(os.path.dirname(DEVICE_ID_FILE), exist_ok=True)
        with open(DEVICE_ID_FILE, "w", encoding="utf-8") as fh:
            fh.write(value)
    except Exception:
        pass
    return value


def cert_san():
    """The SAN entries of the leaf certificate, or [] when it cannot be read."""
    try:
        decoded = ssl._ssl._test_decode_cert(TLS_CERT)
        return list(decoded.get("subjectAltName", ()))
    except Exception:
        return []


def cert_fingerprint():
    """SHA-256 of the leaf DER, so a phone can pin the identity, not the IP."""
    try:
        with open(TLS_CERT, "r", encoding="utf-8") as fh:
            der = ssl.PEM_cert_to_DER_cert(fh.read())
        return hashlib.sha256(der).hexdigest()
    except Exception:
        return None


def _required_cert_names():
    """Names and addresses the certificate must cover right now."""
    host = socket.gethostname()
    names = {
        "localhost",
        "taildeck.local",
        host,
        host.lower(),
        f"{host.lower()}.local",
    }
    tailnet = tailnet_dns_name()
    if tailnet:
        names.add(tailnet)
    addresses = {"127.0.0.1"} | {item["address"] for item in usable_interfaces()}
    return names, addresses


def ensure_certificate(tls_context=None):
    """Regenerate the leaf certificate when an address it must cover has moved.

    The CA is reused, so phones that installed it stay valid. When a live TLS
    context is supplied it is reloaded in place, which lets the running listener
    pick up the new certificate without a restart.
    """
    ca_key = os.path.join(TLS_DIR, "ca.key")
    if not all(os.path.isfile(path) for path in (TLS_CERT, TLS_KEY, TLS_CA, ca_key)):
        return False
    if not shutil.which("openssl"):
        return False

    names, addresses = _required_cert_names()
    san = cert_san()
    have_names = {value for kind, value in san if kind == "DNS"}
    have_addresses = {value for kind, value in san if kind == "IP Address"}
    if names.issubset(have_names) and addresses.issubset(have_addresses):
        return False

    san_text = ",".join(
        [f"DNS:{name}" for name in sorted(names)]
        + [f"IP:{address}" for address in sorted(addresses)]
    )
    csr = os.path.join(TLS_DIR, "taildeck.csr")
    ext = os.path.join(TLS_DIR, "san.ext")
    try:
        with open(ext, "w", encoding="utf-8") as fh:
            fh.write(
                "basicConstraints=CA:FALSE\n"
                "keyUsage=digitalSignature,keyEncipherment\n"
                "extendedKeyUsage=serverAuth\n"
                f"subjectAltName={san_text}\n"
            )
        subprocess.run(
            ["openssl", "genrsa", "-out", TLS_KEY, "2048"],
            check=True, capture_output=True, timeout=20,
        )
        subprocess.run(
            ["openssl", "req", "-new", "-key", TLS_KEY, "-out", csr, "-subj", "/CN=TailDeck"],
            check=True, capture_output=True, timeout=20,
        )
        subprocess.run(
            [
                "openssl", "x509", "-req", "-in", csr,
                "-CA", TLS_CA, "-CAkey", ca_key, "-CAcreateserial",
                "-out", TLS_CERT, "-days", "825", "-sha256", "-extfile", ext,
            ],
            check=True, capture_output=True, timeout=20,
        )
        try:
            os.chmod(TLS_KEY, 0o600)
        except Exception:
            pass
    except Exception as exc:
        print(f"[TailDeck] certificate refresh failed: {exc}", flush=True)
        return False
    finally:
        for path in (csr, ext):
            try:
                os.unlink(path)
            except Exception:
                pass

    if tls_context is not None:
        try:
            tls_context.load_cert_chain(TLS_CERT, TLS_KEY)
        except Exception as exc:
            print(f"[TailDeck] TLS reload failed: {exc}", flush=True)
    return True


def discovery_payload():
    """What the phone needs to decide how to reach this laptop."""
    tailnet = tailnet_dns_name()
    return {
        "t": "td_beacon",
        "v": 1,
        "id": device_id(),
        "name": socket.gethostname(),
        "daemon": DAEMON_VERSION,
        "ports": {"http": PORT, "https": TLS_PORT},
        "interfaces": usable_interfaces(),
        "addresses": local_ipv4_addresses(),
        "certSha256": cert_fingerprint(),
        "certNames": sorted({value for kind, value in cert_san() if kind == "DNS"}),
        "tailnet": tailnet,
        "ts": int(time.time()),
    }


_STOP = threading.Event()


def _beacon_listener():
    """Answer a phone's `td_probe` (unicast or multicast) without waiting a cycle."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", BEACON_PORT))
    except Exception:
        sock.close()
        return
    # A phone that cannot broadcast on its own AP interface can still join the
    # group and probe it. Join on every usable link; failures are non-fatal.
    for item in usable_interfaces():
        try:
            mreq = socket.inet_aton(BEACON_GROUP) + socket.inet_aton(item["address"])
            sock.setsockopt(socket.IPPROTO_IP, 35, mreq)  # IP_ADD_MEMBERSHIP
        except Exception:
            pass
    sock.settimeout(2.0)
    while not _STOP.is_set():
        try:
            data, peer = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except Exception:
            break
        if not data.strip().startswith(b"td_probe"):
            continue
        try:
            sock.sendto(json.dumps(discovery_payload()).encode("utf-8"), peer)
        except Exception:
            pass
    try:
        sock.close()
    except Exception:
        pass


def _beacon_broadcaster():
    """Announce on every usable interface, so no IP range is assumed."""
    while not _STOP.wait(0.2):
        payload = json.dumps(discovery_payload()).encode("utf-8")
        for item in usable_interfaces():
            for target in (item.get("broadcast"), "255.255.255.255", BEACON_GROUP):
                if not target:
                    continue
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    try:
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                        try:
                            sock.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, item["interface"].encode())
                        except Exception:
                            pass
                        sock.sendto(payload, (target, BEACON_PORT))
                    finally:
                        sock.close()
                except Exception:
                    pass
        _STOP.wait(BEACON_INTERVAL)


def start_discovery():
    threading.Thread(target=_beacon_listener, daemon=True, name="taildeck-beacon-rx").start()
    threading.Thread(target=_beacon_broadcaster, daemon=True, name="taildeck-beacon-tx").start()


def _identity_watch(tls_context):
    """Keep the certificate in step with the laptop's current addresses."""
    while not _STOP.wait(30.0):
        try:
            if ensure_certificate(tls_context):
                print(
                    "[TailDeck] Certificate refreshed for the current addresses "
                    f"({', '.join(local_ipv4_addresses()) or 'no LAN address'})",
                    flush=True,
                )
        except Exception as exc:
            print(f"[TailDeck] certificate watch: {exc}", flush=True)


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
            # _http needs the Origin to decide whether to echo it and whether
            # a loopback caller is really the laptop's own page, and it has no
            # request object of its own, so carry it on this handler thread.
            try:
                REQUEST_ORIGIN.origin = _parse_headers(data).get("origin", "")
            except Exception:
                REQUEST_ORIGIN.origin = ""
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

        # Remote-desktop sessions ride the same listener but bypass the command
        # protocol: the WebSocket *is* the RFB stream from here on. An RFB
        # client cannot send a JSON hello, so it proves itself with a query
        # token instead (the app does not currently open this route).
        request_target = data.split(" ", 2)[1] if " " in data else ""
        local_client = _request_is_local(conn, headers)
        if request_target.split("?")[0] == "/api/rdp/ws":
            rdp_token = _query(request_target).get("token", "")
            if not (local_client or _device_token_ok(rdp_token)):
                send_ws_close(conn, 4401, "pairing required")
                conn.close()
                return
            print(f"[TailDeck] rdp open {logged_peer}", flush=True)
            record_connection("connected", logged_peer, scheme, route, "rdp")
            _rdp_proxy(conn)
            record_connection("closed", logged_peer, scheme, route, "rdp")
            conn.close()
            return

        # Pairing or an existing device token must arrive before anything else.
        # A local browser is already trusted (a local process can drive input
        # anyway); a remote client gets five seconds to prove itself.
        authed = local_client
        if not authed:
            authed = _ws_authenticate(conn)

        if not authed:
            print(f"[TailDeck] ws rejected {logged_peer}: pairing required", flush=True)
            send_ws_close(conn, 4401, "pairing required")
            conn.close()
            return

        # Send initial host handshake message
        welcome = {
            "type": "host_info",
            # Stable identity, independent of the address or hostname. A phone
            # keys its candidates on this so moving networks is not a new laptop.
            "id": device_id(),
            "hostname": socket.gethostname(),
            "os": sys.platform,
            "session": "Wayland" if "wayland" in SESSION_TYPE else ("X11" if "x11" in SESSION_TYPE else "Unknown"),
            "backend": BACKEND_NAME,
            # How the phone can reach this laptop next time. The LAN addresses
            # only work on the same hotspot; the tailnet name works anywhere.
            # Only interfaces a phone can actually reach are listed; container
            # bridges and tunnels are filtered out.
            "addresses": local_ipv4_addresses(),
            "interfaces": usable_interfaces(),
            "tailnet": tailnet_dns_name(),
            "ports": {"http": PORT, "https": TLS_PORT},
            # Pin the leaf, not the address: a new DHCP lease must not look like
            # a different laptop to a phone that has seen it before.
            "certSha256": cert_fingerprint(),
            "certNames": sorted({value for kind, value in cert_san() if kind == "DNS"}),
            # Which optional endpoint groups this daemon answers, so a client
            # can hide controls instead of probing.
            "capabilities": _capabilities(),
            # Whole-screen size, so a client can pick a sane scale before it asks
            # for the first frame.
            "screen": _screen_info(),
        }
        send_ws_frame(conn, json.dumps(welcome))

        # Send the current track up front, so a client connecting between two
        # changes is not left on "nothing playing" until the next one arrives.
        try:
            send_ws_frame(conn, json.dumps({"type": "media_now", **now_playing()}))
        except Exception:
            pass

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
                    DICTATION.on_partial = lambda t: send_ws_frame(
                        conn, json.dumps({"type": "dictation_partial", "text": t})
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
                elif mtype == "dictation_cancel":
                    DICTATION.cancel(conn)
                    print(f"[TailDeck] {peer} dictation_cancel bytes={dictation_bytes}", flush=True)
                    send_ws_frame(conn, json.dumps({"type": "dictation_stopped"}))
                elif mtype == "record_start":
                    path = RECORDING.start(
                        conn,
                        int(msg.get("sampleRate", 16000) or 16000),
                        str(msg.get("label", "")),
                    )
                    print(f"[TailDeck] {peer} record_start ok={path is not None}", flush=True)
                    send_ws_frame(conn, json.dumps({
                        "type": "record_ready",
                        "ok": path is not None,
                        "path": os.path.basename(path) if path else None,
                    }))
                elif mtype == "record_audio":
                    RECORDING.audio(base64.b64decode(msg.get("data", "")), conn)
                elif mtype == "record_stop":
                    path = RECORDING.stop(conn)
                    send_ws_frame(conn, json.dumps({
                        "type": "record_stopped",
                        "path": os.path.basename(path) if path else None,
                    }))
                elif mtype == "record_cancel":
                    RECORDING.stop(conn, discard=True)
                    send_ws_frame(conn, json.dumps({"type": "record_stopped"}))
                elif mtype == "ping":
                    pong = {"type": "pong", "timestamp": msg.get("timestamp", time.time() * 1000)}
                    send_ws_frame(conn, json.dumps(pong))
            except Exception as e:
                # A malformed frame must not kill the connection, but it must
                # not vanish either: this used to be a silent `pass`.
                print(f"[TailDeck] {peer} message error: {e}", flush=True)
                try:
                    send_ws_frame(conn, json.dumps({
                        "type": "error",
                        "error": str(e)[:200] or "invalid message",
                    }))
                except Exception:
                    pass
    except Exception as e:
        print(f"[TailDeck] {logged_peer} connection error: {e}", flush=True)
    finally:
        if is_ws:
            DICTATION.stop(conn)
            # Finalise any WAV still open: a client that vanishes mid-recording
            # must still leave a playable file behind.
            RECORDING.stop(conn)
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


def send_ws_close(conn, code, reason=""):
    """Close a websocket with a status code the client can act on."""
    try:
        payload = struct.pack("!H", int(code)) + str(reason).encode("utf-8")[:120]
        header = bytearray([0x88])
        if len(payload) <= 125:
            header.append(len(payload))
        else:
            header.append(126)
            header.extend(struct.pack("!H", len(payload)))
        conn.sendall(bytes(header) + payload)
    except Exception:
        pass


def _ws_authenticate(conn, timeout=5.0):
    """Read the first frame: `hello` with a device token, or `pair` with a
    one-time code. Returns True when the connection may proceed.

    The server deliberately sends nothing before this, so an unauthenticated
    client learns neither the hostname nor the addresses.
    """
    try:
        conn.settimeout(timeout)
    except Exception:
        pass
    try:
        payload = read_ws_frame(conn)
    finally:
        try:
            conn.settimeout(None)
        except Exception:
            pass
    if not payload:
        return False
    try:
        msg = json.loads(payload)
    except Exception:
        return False
    if not isinstance(msg, dict):
        return False

    mtype = msg.get("type")
    if mtype == "hello":
        return _device_token_ok(str(msg.get("token") or ""))

    if mtype == "pair":
        label = _consume_pair_code(str(msg.get("code") or ""))
        if label is None:
            send_ws_frame(conn, json.dumps({
                "type": "pair_error",
                "error": "That pairing code is not valid or has expired.",
            }))
            return False
        dev_id, token = _mint_device(msg.get("label") or label)
        if not token:
            send_ws_frame(conn, json.dumps({
                "type": "pair_error",
                "error": "Could not save the paired device.",
            }))
            return False
        print(f"[TailDeck] paired device {dev_id} ({label})", flush=True)
        send_ws_frame(conn, json.dumps({
            "type": "paired",
            "id": dev_id,
            "token": token,
            "label": label,
        }))
        return True

    return False


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
        # A moved address used to leave the old IP in the certificate, which
        # Android WebView cancels without explanation. Heal it before the TLS
        # listener starts; the watcher below keeps it in step afterwards.
        try:
            if ensure_certificate():
                print("[TailDeck] Certificate refreshed for the current addresses")
        except Exception as exc:
            print(f"[TailDeck] certificate check skipped: {exc}")

        tls_context = build_tls_context()
        atexit.register(_vnc_stop)
        atexit.register(_STOP.set)

        print(f"[TailDeck] Daemon listening on 0.0.0.0:{PORT} (Tailscale IP compatible)")
        print(f"[TailDeck] Session: {SESSION_TYPE.upper()} | Backend: {BACKEND_NAME}")
        print("[TailDeck] Ready for Android remote trackpad connection!")
        print(f"[TailDeck] Connection log: {CONNECTION_LOG} "
              f"(notify={'on' if NOTIFY_CONNECTIONS else 'off'})")
        print(f"[TailDeck] Web app root: {WEBROOT} "
              f"({'found' if os.path.isfile(os.path.join(WEBROOT, 'index.html')) else 'not published'})")
        print(f"[TailDeck] Scripts folder: {SCRIPTS_DIR} "
              f"({'found' if os.path.isdir(SCRIPTS_DIR) else 'created on first save'})")
        print(f"[TailDeck] Share folder: {SHARE_DIR} "
              f"({'found' if os.path.isdir(SHARE_DIR) else 'created on first upload'})")
        print(f"[TailDeck] Clipboard watch: {'on' if CLIPBOARD_WATCH else 'off'} "
              f"(set TAILDECK_CLIPBOARD_WATCH=1 to sync to phones)")
        print(f"[TailDeck] Remote desktop: "
              f"{'ready (x11vnc + /api/rdp/start)' if _rdp_supported() else 'unavailable (needs X11 + x11vnc)'}")
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
        print(f"[TailDeck] Identity: {device_id()} "
              f"cert={'pinned ' + (cert_fingerprint() or 'none')[:16] if cert_fingerprint() else 'none'}")
        print(f"[TailDeck] Discovery: UDP {BEACON_PORT} every {BEACON_INTERVAL:g}s on "
              f"{', '.join(item['interface'] for item in usable_interfaces()) or 'no usable interface'}")

        start_discovery()
        if tls_context is not None:
            threading.Thread(
                target=_identity_watch, args=(tls_context,), daemon=True, name="taildeck-identity"
            ).start()

        if tls_context is not None:
            t = threading.Thread(
                target=run_ws_server, kwargs={"port": TLS_PORT, "tls_context": tls_context}, daemon=True
            )
            t.start()

        if CLIPBOARD_WATCH:
            threading.Thread(target=_clipboard_watcher, daemon=True).start()

        if _has_command("busctl"):
            threading.Thread(target=_media_watcher, daemon=True).start()

        run_ws_server()
    except KeyboardInterrupt:
        _vnc_stop()
        print("\n[TailDeck] Daemon stopped.")
