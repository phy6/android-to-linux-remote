import React, { useState, useRef, useEffect } from 'react';
import { ConnectionStatus, RemoteSettings, SessionType } from '../types';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import { PWAInstallButton } from './PWAInstallButton';
import {
  Wifi,
  WifiOff,
  Activity,
  Download,
  Copy,
  Check,
  Terminal,
  Shield,
  Layers,
  Sliders,
  Keyboard,
  Monitor,
  X,
  ChevronRight,
  ChevronLeft,
  Volume2,
  Vibrate,
  Gauge,
  Mic,
  Repeat2,
  CornerDownLeft,
  Delete,
  Volume1,
  VolumeX,
  Play,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Send,
} from 'lucide-react';

interface SideMenuDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  connectionStatus: ConnectionStatus;
  settings: RemoteSettings;
  onUpdateSettings: (newSettings: Partial<RemoteSettings>) => void;
  onToggleSimulator: () => void;
  isSimulatorActive: boolean;
}

export const SideMenuDrawer: React.FC<SideMenuDrawerProps> = ({
  isOpen,
  onClose,
  onOpen,
  connectionStatus,
  settings,
  onUpdateSettings,
  onToggleSimulator,
  isSimulatorActive,
}) => {
  const { triggerClick } = useHaptics(settings.hapticFeedback, settings.soundFeedback);
  const [tailscaleIp, setTailscaleIp] = useState(connectionStatus.hostAddress || '192.0.2.10:8080');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tailscale' | 'keys' | 'settings'>('tailscale');
  const [quickInput, setQuickInput] = useState('');

  // Drag handle gesture refs
  const drawerRef = useRef<HTMLDivElement>(null);
  const dragStartXRef = useRef<number | null>(null);
  const currentDragXRef = useRef<number>(0);
  const [dragProgress, setDragProgress] = useState<number | null>(null); // 0 to 1

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    triggerClick();
    linuxClient.connect(tailscaleIp);
  };

  const handleDisconnect = () => {
    triggerClick();
    linuxClient.disconnect();
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    triggerClick();
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const sendKey = (key: string) => {
    triggerClick();
    linuxClient.sendKeyCombo([key]);
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput) return;
    triggerClick();
    linuxClient.sendTypeText(quickInput);
    setQuickInput('');
  };

  const oneLinerCommand = `curl -sSL "${window.location.origin}/taildeck-daemon.py" -o taildeck-daemon.py && python3 taildeck-daemon.py`;

  // Edge drag detection on left side of screen
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      // If closed, only initiate drag if touch starts near the left edge (< 32px)
      if (!isOpen && touch.clientX < 32) {
        dragStartXRef.current = touch.clientX;
        currentDragXRef.current = touch.clientX;
      } else if (isOpen) {
        dragStartXRef.current = touch.clientX;
        currentDragXRef.current = touch.clientX;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (dragStartXRef.current === null) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - dragStartXRef.current;

      if (!isOpen) {
        // Dragging in from left
        const progress = Math.min(1, Math.max(0, deltaX / 280));
        setDragProgress(progress);
        if (progress > 0.4) {
          onOpen();
          dragStartXRef.current = null;
          setDragProgress(null);
        }
      } else {
        // Dragging out to left to close
        if (deltaX < -50) {
          onClose();
          dragStartXRef.current = null;
          setDragProgress(null);
        }
      }
    };

    const handleTouchEnd = () => {
      dragStartXRef.current = null;
      setDragProgress(null);
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd);

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isOpen, onOpen, onClose]);

  return (
    <>
      {/* Edge Handle Tab (always visible on left side for convenient pull/tap) */}
      {!isOpen && (
        <div
          onClick={() => {
            triggerClick();
            onOpen();
          }}
          className="fixed left-0 top-1/2 -translate-y-1/2 z-30 flex items-center justify-center w-5 h-16 rounded-r-xl bg-slate-900/90 border-r border-y border-slate-700/80 shadow-lg text-slate-400 hover:text-white cursor-pointer active:scale-95 transition-all select-none touch-none backdrop-blur-md opacity-40 hover:opacity-100"
          title="Drag or tap to open menu & Tailscale settings"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </div>
      )}

      {/* Backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm transition-opacity animate-fadeIn"
        />
      )}

      {/* Slide-in Menu Drawer */}
      <div
        ref={drawerRef}
        className={`fixed inset-y-0 left-0 z-50 w-full max-w-sm bg-slate-950 border-r border-slate-800 shadow-2xl flex flex-col transition-transform duration-300 ease-out select-none ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/90">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm leading-tight">TailDeck Menu</h3>
              <p className="text-[11px] text-slate-400">Tailscale & Linux Host Remote</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-900/40 px-3 pt-2 gap-1 text-xs">
          <button
            onClick={() => setActiveTab('tailscale')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
              activeTab === 'tailscale'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>Tailscale</span>
          </button>

          <button
            onClick={() => setActiveTab('keys')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
              activeTab === 'keys'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span>Keyboard</span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
              activeTab === 'settings'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Touchpad</span>
          </button>
        </div>

        {/* Drawer Body Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* TAB 1: TAILSCALE CONNECTION */}
          {activeTab === 'tailscale' && (
            <div className="space-y-4 text-xs">
              {/* Status Banner */}
              <div
                className={`p-3.5 rounded-2xl border flex items-center justify-between ${
                  connectionStatus.connected
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                    : connectionStatus.connecting
                    ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      connectionStatus.connected
                        ? 'bg-emerald-400 animate-pulse'
                        : connectionStatus.connecting
                        ? 'bg-amber-400 animate-ping'
                        : 'bg-slate-600'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">
                      {connectionStatus.connected
                        ? 'Connected to Linux Host'
                        : connectionStatus.connecting
                        ? 'Connecting to Tailscale...'
                        : 'Disconnected'}
                    </div>
                    {connectionStatus.connected && connectionStatus.hostOsInfo && (
                      <div className="text-[11px] text-slate-400">
                        {connectionStatus.hostOsInfo.hostname} • {connectionStatus.hostOsInfo.session}
                      </div>
                    )}
                  </div>
                </div>

                {connectionStatus.connected && connectionStatus.latencyMs !== null && (
                  <div className="flex items-center gap-1 font-mono text-xs text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded-lg border border-emerald-800">
                    <Activity className="w-3 h-3" />
                    <span>{connectionStatus.latencyMs} ms</span>
                  </div>
                )}
              </div>

              {/* IP Input Form */}
              <form onSubmit={handleConnect} className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Laptop Tailscale IP:
                  </label>
                  <input
                    type="text"
                    value={tailscaleIp}
                    onChange={(e) => setTailscaleIp(e.target.value)}
                    placeholder="e.g. 192.0.2.10:8080"
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-sky-500"
                  />
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Find IP on laptop: <code className="text-sky-400">tailscale ip -4</code>
                  </span>
                </div>

                {connectionStatus.connected ? (
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="w-full py-2.5 px-4 rounded-xl font-medium text-xs bg-rose-600/20 text-rose-300 border border-rose-500/40 hover:bg-rose-600/30 transition"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={connectionStatus.connecting}
                    className="w-full py-2.5 px-4 rounded-xl font-medium text-xs bg-sky-600 text-white hover:bg-sky-500 shadow-md shadow-sky-600/30 transition flex items-center justify-center gap-2"
                  >
                    <Wifi className="w-4 h-4" />
                    <span>{connectionStatus.connecting ? 'Connecting...' : 'Connect to Laptop'}</span>
                  </button>
                )}
              </form>

              {/* Quick Run Command on Linux Laptop */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="font-semibold text-slate-300">Run on your Laptop:</span>
                  <button
                    onClick={() => copyToClipboard(oneLinerCommand, 'cmd')}
                    className="flex items-center gap-1 text-sky-400 hover:text-sky-300"
                  >
                    {copiedCode === 'cmd' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedCode === 'cmd' ? 'Copied' : 'Copy Command'}</span>
                  </button>
                </div>
                <div className="p-2.5 bg-slate-900 rounded-xl border border-slate-800 font-mono text-[11px] text-emerald-400 overflow-x-auto select-all">
                  {oneLinerCommand}
                </div>
              </div>

              {/* Download daemon link */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  <span className="text-xs text-slate-300">taildeck-daemon.py</span>
                </div>
                <a
                  href="/taildeck-daemon.py"
                  download="taildeck-daemon.py"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 text-sky-400 text-xs font-medium hover:bg-slate-700 transition"
                >
                  <Download className="w-3 h-3" />
                  <span>Download</span>
                </a>
              </div>

              {/* Wayland & X11 compatibility badge */}
              <div className="p-2.5 rounded-xl bg-sky-950/20 border border-sky-500/20 text-slate-400 text-[11px] flex items-start gap-2">
                <Shield className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <span>
                  Uses Linux kernel <code className="text-sky-300">/dev/uinput</code>. Compatible with GNOME Wayland, KDE Plasma 6, Hyprland, Sway, and X11.
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: REMOTE KEYBOARD & HOTKEYS */}
          {activeTab === 'keys' && (
            <div className="space-y-3 text-xs">
              {/* Quick Text Type to Laptop */}
              <form onSubmit={handleSendText} className="flex gap-2">
                <input
                  type="text"
                  value={quickInput}
                  onChange={(e) => setQuickInput(e.target.value)}
                  placeholder="Type directly into laptop..."
                  className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono"
                />
                <button
                  type="submit"
                  disabled={!quickInput}
                  className="px-3 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white rounded-xl text-xs font-medium flex items-center gap-1 transition"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>

              {/* Linux Modifiers & Hotkeys */}
              <div className="grid grid-cols-3 gap-1.5 pt-1">
                <button
                  onClick={() => sendKey('Super_L')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-sky-400 font-bold active:scale-95 text-xs"
                >
                  SUPER (Win)
                </button>
                <button
                  onClick={() => sendKey('Escape')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  ESC
                </button>
                <button
                  onClick={() => sendKey('Tab')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  TAB
                </button>
                <button
                  onClick={() => sendKey('Control_L')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  CTRL
                </button>
                <button
                  onClick={() => sendKey('Alt_L')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  ALT
                </button>
                <button
                  onClick={() => sendKey('BackSpace')}
                  className="py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-rose-300 flex items-center justify-center active:scale-95"
                >
                  <Delete className="w-4 h-4" />
                </button>
              </div>

              {/* Media Controls */}
              <div className="flex items-center justify-around bg-slate-900/60 p-2 rounded-xl border border-slate-800">
                <button
                  onClick={() => sendKey('XF86AudioMute')}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Mute"
                >
                  <VolumeX className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioLowerVolume')}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Volume Down"
                >
                  <Volume1 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioRaiseVolume')}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Volume Up"
                >
                  <Volume2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioPlay')}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Play / Pause"
                >
                  <Play className="w-4 h-4" />
                </button>
              </div>

              {/* Arrows & Enter */}
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => sendKey('Left')}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => sendKey('Up')}
                    className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => sendKey('Down')}
                    className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                </div>
                <button
                  onClick={() => sendKey('Right')}
                  className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>

                <button
                  onClick={() => sendKey('Return')}
                  className="px-4 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-medium flex items-center gap-1.5 text-xs active:scale-95 ml-2"
                >
                  <CornerDownLeft className="w-4 h-4" />
                  <span>ENTER</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: TOUCHPAD SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-4 text-xs">
              {/* Sensitivity Slider */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5 text-sky-400" />
                    <span>Sensitivity: {settings.sensitivity.toFixed(1)}x</span>
                  </span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="3.0"
                  step="0.1"
                  value={settings.sensitivity}
                  onChange={(e) => onUpdateSettings({ sensitivity: parseFloat(e.target.value) })}
                  className="w-full accent-sky-400 cursor-pointer"
                />
              </div>

              {/* Mic Button Behaviour */}
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Mic className="w-3.5 h-3.5 text-sky-400" />
                  <span>Long-press mic to talk</span>
                </span>
                <button
                  onClick={() => onUpdateSettings({ holdToTalk: !settings.holdToTalk })}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                    settings.holdToTalk
                      ? 'bg-sky-600/80 border-sky-500/60 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {settings.holdToTalk ? 'Long press' : 'Tap'}
                </button>
              </div>
              <p className="text-[10px] text-slate-500 -mt-2">
                Hold to talk and release to send. Tap mode starts talking on touch instead.
              </p>

              {/* Auto Connect */}
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-sky-400" />
                  <span>Reconnect on open</span>
                </span>
                <button
                  onClick={() => onUpdateSettings({ autoConnect: !settings.autoConnect })}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                    settings.autoConnect
                      ? 'bg-sky-600/80 border-sky-500/60 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {settings.autoConnect ? 'On' : 'Off'}
                </button>
              </div>
              <p className="text-[10px] text-slate-500 -mt-2">
                The host address is remembered automatically once you connect.
              </p>

              {/* App Switcher Travel Distance */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <Repeat2 className="w-3.5 h-3.5 text-sky-400" />
                    <span>App switcher spacing: {settings.wheelSensitivity}px</span>
                  </span>
                </div>
                <input
                  type="range"
                  min="70"
                  max="260"
                  step="10"
                  value={settings.wheelSensitivity}
                  onChange={(e) =>
                    onUpdateSettings({ wheelSensitivity: parseInt(e.target.value, 10) })
                  }
                  className="w-full accent-sky-400 cursor-pointer"
                />
                <p className="text-[10px] text-slate-500">
                  Pixels of travel per app switch. Higher values spread the apps further apart.
                </p>
              </div>

              {/* Acceleration Curve */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-300">
                    Acceleration: {settings.acceleration.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.05"
                  value={settings.acceleration}
                  onChange={(e) => onUpdateSettings({ acceleration: parseFloat(e.target.value) })}
                  className="w-full accent-emerald-400 cursor-pointer"
                />
              </div>

              {/* Toggles */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Vibrate className="w-4 h-4 text-sky-400" />
                    <span className="font-medium text-slate-300">Haptic Vibration</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.hapticFeedback}
                    onChange={(e) => onUpdateSettings({ hapticFeedback: e.target.checked })}
                    className="w-4 h-4 accent-sky-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Volume2 className="w-4 h-4 text-indigo-400" />
                    <span className="font-medium text-slate-300">Click Sounds</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.soundFeedback}
                    onChange={(e) => onUpdateSettings({ soundFeedback: e.target.checked })}
                    className="w-4 h-4 accent-indigo-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer">
                  <span className="font-medium text-slate-300">Tap to Click</span>
                  <input
                    type="checkbox"
                    checked={settings.tapToClick}
                    onChange={(e) => onUpdateSettings({ tapToClick: e.target.checked })}
                    className="w-4 h-4 accent-sky-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer">
                  <span className="font-medium text-slate-300">Two-Finger Right Click</span>
                  <input
                    type="checkbox"
                    checked={settings.twoFingerRightClick}
                    onChange={(e) => onUpdateSettings({ twoFingerRightClick: e.target.checked })}
                    className="w-4 h-4 accent-sky-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer">
                  <span className="font-medium text-slate-300">Invert Scroll Direction</span>
                  <input
                    type="checkbox"
                    checked={settings.invertScroll}
                    onChange={(e) => onUpdateSettings({ invertScroll: e.target.checked })}
                    className="w-4 h-4 accent-sky-500 rounded"
                  />
                </label>
              </div>

              {/* Linux Desktop Simulator Toggle */}
              <div className="pt-2">
                <button
                  onClick={onToggleSimulator}
                  className={`w-full py-2.5 px-3 rounded-xl border flex items-center justify-center gap-2 text-xs font-medium transition ${
                    isSimulatorActive
                      ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                      : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Monitor className="w-4 h-4" />
                  <span>{isSimulatorActive ? 'Hide Desktop Simulator' : 'Show Desktop Simulator'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer with PWA Install Button */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/90 flex items-center justify-between">
          <PWAInstallButton />
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
};
