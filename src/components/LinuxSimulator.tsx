import React, { useState, useEffect, useRef } from 'react';
import { linuxClient } from '../services/linuxClient';
import { InputEventPayload } from '../types';
import { Terminal, Globe, Code2, Folder, X, Minus, Square, Wifi, Battery, Volume2, Shield } from 'lucide-react';

interface LinuxSimulatorProps {
  activeAppIndex: number;
  onAppSwitch: (direction: 'prev' | 'next') => void;
  onClose?: () => void;
}

interface WindowData {
  id: string;
  title: string;
  app: string;
  icon: React.ComponentType<{ className?: string }>;
  content: 'terminal' | 'browser' | 'editor' | 'files';
}

const WINDOWS: WindowData[] = [
  { id: 'term', title: 'user@thinkpad: ~ (bash)', app: 'Terminal', icon: Terminal, content: 'terminal' },
  { id: 'web', title: 'Linux Kernel & Wayland Docs - Firefox', app: 'Firefox', icon: Globe, content: 'browser' },
  { id: 'code', title: 'taildeck-daemon.py - VS Code', app: 'VS Code', icon: Code2, content: 'editor' },
  { id: 'files', title: 'Home / Documents - Files', app: 'Files', icon: Folder, content: 'files' },
];

export const LinuxSimulator: React.FC<LinuxSimulatorProps> = ({
  activeAppIndex,
  onAppSwitch,
  onClose,
}) => {
  // Simulated mouse position on the desktop (in percentage 0-100%)
  const [cursorPos, setCursorPos] = useState({ x: 50, y: 50 });
  const [isClicking, setIsClicking] = useState(false);
  const [clickRipples, setClickRipples] = useState<{ id: number; x: number; y: number; type: string }[]>([]);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([
    'Linux 6.8.0-generic x86_64 (Wayland session active)',
    'Tailscale mesh connected to your laptop',
    'taildeck-daemon.py initialized via /dev/uinput (low latency)',
    'Type or speak to send input...',
  ]);
  const [currentInput, setCurrentInput] = useState('');
  const [showAltTabOverlay, setShowAltTabOverlay] = useState(false);
  const altTabTimerRef = useRef<number | null>(null);

  // Subscribe to real-time events from linuxClient
  useEffect(() => {
    const unsubscribe = linuxClient.subscribe((event: InputEventPayload) => {
      if (event.type === 'move') {
        setCursorPos((prev) => {
          // Scale relative dx, dy to 0-100% boundary
          const nextX = Math.max(2, Math.min(98, prev.x + event.dx * 0.12));
          const nextY = Math.max(4, Math.min(96, prev.y + event.dy * 0.12));
          return { x: nextX, y: nextY };
        });
      } else if (event.type === 'click') {
        setIsClicking(true);
        setTimeout(() => setIsClicking(false), 160);

        // Add visual click ripple at current cursor pos
        const rippleId = Date.now();
        setClickRipples((prev) => [
          ...prev.slice(-3),
          { id: rippleId, x: cursorPos.x, y: cursorPos.y, type: event.button },
        ]);
        setTimeout(() => {
          setClickRipples((prev) => prev.filter((r) => r.id !== rippleId));
        }, 500);
      } else if (event.type === 'app_switch') {
        setShowAltTabOverlay(true);
        if (altTabTimerRef.current) clearTimeout(altTabTimerRef.current);
        altTabTimerRef.current = window.setTimeout(() => {
          setShowAltTabOverlay(false);
        }, 1200);
      } else if (event.type === 'type_text') {
        setCurrentInput((prev) => prev + event.text);
      } else if (event.type === 'key_combo') {
        if (event.keys.includes('Return') || event.keys.includes('Enter')) {
          setCurrentInput((text) => {
            if (text) {
              setTerminalHistory((hist) => [...hist, `$ ${text}`, `Command received: "${text}"`]);
            }
            return '';
          });
        }
      }
    });

    return () => {
      unsubscribe();
      if (altTabTimerRef.current) clearTimeout(altTabTimerRef.current);
    };
  }, [cursorPos]);

  const activeWindow = WINDOWS[activeAppIndex % WINDOWS.length];
  const ActiveIcon = activeWindow.icon;

  return (
    <div className="relative w-full h-full bg-slate-950 flex flex-col overflow-hidden rounded-2xl border border-slate-700/80 shadow-2xl">
      {/* Linux Top Bar (GNOME Shell Style) */}
      <div className="h-7 bg-slate-950/95 border-b border-slate-800 px-3 flex items-center justify-between text-[11px] text-slate-300 select-none z-20">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white">Activities</span>
          <span className="text-slate-400 font-medium truncate max-w-[150px]">
            {activeWindow.title}
          </span>
        </div>

        <div className="font-mono text-slate-200 font-medium">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>

        <div className="flex items-center gap-2 text-slate-400">
          <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800/50">
            <Shield className="w-2.5 h-2.5" />
            <span>Wayland</span>
          </span>
          <Wifi className="w-3 h-3 text-slate-300" />
          <Volume2 className="w-3 h-3 text-slate-300" />
          <Battery className="w-3.5 h-3.5 text-emerald-400" />
        </div>
      </div>

      {/* Linux Desktop Area with Wallpaper */}
      <div
        className="relative flex-1 bg-gradient-to-br from-indigo-950 via-slate-900 to-sky-950 p-3 sm:p-4 overflow-hidden"
        style={{
          backgroundImage: `radial-gradient(ellipse at 80% 20%, rgba(59, 130, 246, 0.15), transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(99, 102, 241, 0.15), transparent 60%)`,
        }}
      >
        {/* Active Application Window */}
        <div className="w-full h-full max-h-[380px] bg-slate-900/95 rounded-xl border border-slate-700/80 shadow-2xl flex flex-col overflow-hidden backdrop-blur-md">
          {/* Window Header */}
          <div className="h-8 bg-slate-950/90 border-b border-slate-800 px-3 flex items-center justify-between select-none">
            <div className="flex items-center gap-2">
              <ActiveIcon className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-xs font-medium text-slate-200 truncate max-w-[200px]">
                {activeWindow.title}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button className="w-3 h-3 rounded-full bg-amber-500/80 hover:bg-amber-400 flex items-center justify-center">
                <Minus className="w-2 h-2 text-slate-950 opacity-0 hover:opacity-100" />
              </button>
              <button className="w-3 h-3 rounded-full bg-emerald-500/80 hover:bg-emerald-400 flex items-center justify-center">
                <Square className="w-2 h-2 text-slate-950 opacity-0 hover:opacity-100" />
              </button>
              <button className="w-3 h-3 rounded-full bg-rose-500/80 hover:bg-rose-400 flex items-center justify-center">
                <X className="w-2 h-2 text-slate-950 opacity-0 hover:opacity-100" />
              </button>
            </div>
          </div>

          {/* Window Body */}
          <div className="flex-1 p-3 overflow-y-auto font-mono text-xs">
            {activeWindow.content === 'terminal' && (
              <div className="space-y-1 text-slate-300">
                {terminalHistory.map((line, idx) => (
                  <div key={idx} className={line.startsWith('$') ? 'text-sky-300 font-bold' : 'text-slate-400'}>
                    {line}
                  </div>
                ))}
                <div className="flex items-center gap-1 text-emerald-400 pt-1">
                  <span>user@thinkpad:~$</span>
                  <span className="text-white bg-slate-800 px-1 rounded">{currentInput}</span>
                  <span className="w-2 h-4 bg-emerald-400 animate-pulse inline-block" />
                </div>
              </div>
            )}

            {activeWindow.content === 'browser' && (
              <div className="space-y-3 font-sans text-slate-300">
                <div className="flex items-center gap-2 bg-slate-950 p-2 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-500">https://</span>
                  <span className="text-xs text-sky-400">wayland.freedesktop.org/input-injection</span>
                </div>
                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                  <h4 className="font-semibold text-white text-sm mb-1">Wayland & X11 Architecture</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    TailDeck utilizes Linux kernel <code className="text-sky-300 bg-slate-900 px-1 py-0.5 rounded">/dev/uinput</code> or <code className="text-sky-300 bg-slate-900 px-1 py-0.5 rounded">ydotool</code>. This bypasses compositor security barriers seamlessly, working equally on GNOME, KDE, Hyprland, and legacy X11.
                  </p>
                </div>
              </div>
            )}

            {activeWindow.content === 'editor' && (
              <div className="space-y-1 text-slate-400">
                <div className="text-slate-500 text-[11px]">// taildeck-daemon.py - Virtual HID Device</div>
                <div><span className="text-purple-400">import</span> evdev, socket, time</div>
                <div><span className="text-blue-400">def</span> <span className="text-yellow-300">app_switch</span>(direction):</div>
                <div className="pl-4 text-emerald-300"># Left scroll: Alt+Shift+Tab | Right scroll: Alt+Tab</div>
                <div className="pl-4 text-sky-300">ui.write(e.EV_KEY, e.KEY_LEFTALT, 1)</div>
                <div className="pl-4 text-sky-300">ui.write(e.EV_KEY, e.KEY_TAB, 1)</div>
              </div>
            )}

            {activeWindow.content === 'files' && (
              <div className="grid grid-cols-3 gap-2 font-sans text-xs">
                {['Documents', 'Downloads', 'taildeck-daemon.py', 'Pictures', 'Music', 'Projects'].map((f) => (
                  <div key={f} className="p-2 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center gap-2 hover:bg-slate-800">
                    <Folder className="w-4 h-4 text-sky-400" />
                    <span className="truncate">{f}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Alt+Tab App Switcher Overlay (Shows when spinning horizontal wheel!) */}
        {showAltTabOverlay && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-30 flex items-center justify-center p-4 animate-fadeIn">
            <div className="bg-slate-900/90 border border-slate-700 p-4 rounded-2xl shadow-2xl flex items-center gap-3">
              {WINDOWS.map((win, idx) => {
                const isSelected = idx === activeAppIndex % WINDOWS.length;
                const WinIcon = win.icon;
                return (
                  <div
                    key={win.id}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                      isSelected
                        ? 'bg-sky-500/20 border-sky-400 scale-110 shadow-lg shadow-sky-500/20'
                        : 'bg-slate-950/50 border-slate-800 opacity-60'
                    }`}
                  >
                    <WinIcon className={`w-8 h-8 ${isSelected ? 'text-sky-300' : 'text-slate-400'}`} />
                    <span className="text-[11px] font-medium text-slate-200 truncate max-w-[80px]">
                      {win.app}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Simulated Mouse Cursor (Moves via the Trackpad!) */}
        <div
          className="absolute pointer-events-none transition-transform duration-75 ease-out z-40"
          style={{
            left: `${cursorPos.x}%`,
            top: `${cursorPos.y}%`,
            transform: 'translate(-2px, -2px)',
          }}
        >
          {/* Classic Linux White/Black Arrow Cursor */}
          <svg
            className={`w-5 h-5 drop-shadow-md transition-transform ${isClicking ? 'scale-90' : 'scale-100'}`}
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M4 2L19 12L12 14L8 21L4 2Z"
              fill="white"
              stroke="#0f172a"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Click Ripples */}
        {clickRipples.map((ripple) => (
          <div
            key={ripple.id}
            className={`absolute pointer-events-none rounded-full border -translate-x-1/2 -translate-y-1/2 animate-ping ${
              ripple.type === 'right' ? 'border-amber-400 bg-amber-500/30' : 'border-sky-400 bg-sky-500/30'
            }`}
            style={{
              left: `${ripple.x}%`,
              top: `${ripple.y}%`,
              width: 32,
              height: 32,
            }}
          />
        ))}
      </div>
    </div>
  );
};
