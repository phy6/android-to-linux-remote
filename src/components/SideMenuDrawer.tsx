import React, { useState, useRef, useEffect } from 'react';
import { ConnectionStatus, RemoteSettings, SessionType, MediaAction, NowPlaying } from '../types';
import { linuxClient } from '../services/linuxClient';
import { LOCAL_HOST, IS_LOCAL_MODE, describeRoute } from '../services/localMode';
import { useSavedLaptops } from '../services/savedLaptops';
import { decodePairing } from '../services/pairing';
import { useHaptics } from '../hooks/useHaptics';
import { PWAInstallButton } from './PWAInstallButton';
import { PairingCodeModal } from './PairingCodeModal';
import { ScanPairingModal } from './ScanPairingModal';
import { UpdatesPanel } from './UpdatesPanel';
import { UnlockPanel } from './UnlockPanel';
import {
  notificationSupport,
  requestNotificationPermission,
  AlertPermission,
} from '../services/notifications';
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
  Maximize,
  Keyboard,
  Monitor,
  Moon,
  X,
  ChevronRight,
  ChevronLeft,
  Volume2,
  Vibrate,
  Gauge,
  Zap,
  MousePointerClick,
  MousePointer2,
  MoveVertical,
  Mic,
  Bell,
  Repeat2,
  CornerDownLeft,
  Delete,
  Volume1,
  VolumeX,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Music,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  HelpCircle,
  Rocket,
  Wrench,
  ExternalLink,
  QrCode,
  ScanLine,
} from 'lucide-react';

const ToggleRow: React.FC<{
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ icon, label, hint, checked, onChange }) => (
  <div className="space-y-1">
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-900 border border-slate-800 active:scale-[0.99] transition"
    >
      <span className="flex items-center gap-2 font-medium text-slate-300">
        {icon}
        <span>{label}</span>
      </span>
      <span
        className={`relative shrink-0 w-12 h-7 rounded-full border transition-colors ${
          checked ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-6' : 'left-0.5'
          }`}
        />
      </span>
    </button>
    {hint && <p className="text-[10px] text-slate-500 px-1">{hint}</p>}
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{children}</h4>
);

export type SideMenuTab = 'tailscale' | 'keys' | 'media' | 'settings' | 'help';

const MediaNowCard: React.FC<{ now: NowPlaying | null }> = ({ now }) => {
  const title = now?.title ?? '';
  const active = !!now?.active && title.trim() !== '';
  const lengthMs = now?.lengthMs ?? 0;
  const positionMs = now?.positionMs ?? 0;
  const progress = lengthMs > 0 ? Math.min(100, Math.max(0, (positionMs / lengthMs) * 100)) : 0;
  const playing = now?.status === 'Playing';
  const subtitle = active
    ? [now?.artist, now?.album].filter(Boolean).join(' · ') || now?.player || ''
    : 'Play something on the laptop';
  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-3.5">
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
            active
              ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
              : 'bg-slate-800 border-slate-700 text-slate-500'
          }`}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium truncate ${active ? 'text-slate-100' : 'text-slate-400'}`}>
            {active ? title : 'Nothing playing'}
          </div>
          <div className="text-[11px] text-slate-400 truncate">{subtitle}</div>
        </div>
      </div>
      {active && lengthMs > 0 && (
        <div className="mt-3 h-1 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full bg-sky-500" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
};

interface SideMenuDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  /** Tab to bring forward the next time the drawer opens. */
  openTab?: SideMenuTab;
  connectionStatus: ConnectionStatus;
  settings: RemoteSettings;
  onUpdateSettings: (newSettings: Partial<RemoteSettings>) => void;
  onToggleSimulator: () => void;
  onOpenDictation: () => void;
  onOpenDiagnostics: () => void;
  onOpenSetup: () => void;
  isSimulatorActive: boolean;
  onEnterDarkOut: () => void;
  appUpdateReady: boolean;
  onApplyAppUpdate: () => void;
}

export const SideMenuDrawer: React.FC<SideMenuDrawerProps> = ({
  isOpen,
  onClose,
  onOpen,
  openTab,
  connectionStatus,
  settings,
  onUpdateSettings,
  onToggleSimulator,
  onOpenDictation,
  onOpenDiagnostics,
  onOpenSetup,
  isSimulatorActive,
  onEnterDarkOut,
  appUpdateReady,
  onApplyAppUpdate,
}) => {
  const { triggerClick } = useHaptics(settings.hapticFeedback, settings.soundFeedback);
  const pressMedia = (action: MediaAction) => {
    triggerClick();
    linuxClient.sendMedia(action);
  };
  const {
    laptops: savedLaptops,
    refresh: refreshSavedLaptops,
    forget: forgetSavedLaptop,
  } = useSavedLaptops();
  const [tailscaleIp, setTailscaleIp] = useState(connectionStatus.hostAddress || '');
  const [alertPermission, setAlertPermission] = useState<AlertPermission>(notificationSupport());
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tailscale' | 'keys' | 'media' | 'settings' | 'help'>('keys');
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);

  // Now-playing is pushed by the laptop when it changes; the client replays the
  // last one, so a drawer that was closed still shows the current track.
  useEffect(() => linuxClient.onMediaNow(setNowPlaying), []);

  // Honour a requested tab on the closed→open edge, without fighting the user's
  // own tab choice while the drawer stays open.
  const lastOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !lastOpenRef.current && openTab) setActiveTab(openTab);
    lastOpenRef.current = isOpen;
  }, [isOpen, openTab]);
  const [pairMode, setPairMode] = useState<'show' | 'scan' | null>(null);
  const [quickInput, setQuickInput] = useState('');
  const quickInputRef = useRef<HTMLInputElement>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  );

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Opening the drawer on the Keyboard tab should summon the phone's own
  // keyboard immediately, so the big buttons sit ready above it. The short
  // delay lets the slide-in animation settle before focus rearranges the view.
  useEffect(() => {
    if (!isOpen || activeTab !== 'keys') return;
    const t = window.setTimeout(() => quickInputRef.current?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [isOpen, activeTab]);

  // Re-read the saved laptops each time the drawer opens, so a machine we just
  // connected to shows up without a reload.
  useEffect(() => {
    if (isOpen) refreshSavedLaptops();
  }, [isOpen, refreshSavedLaptops]);

  const toggleFullscreen = async () => {
    triggerClick();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // iOS Safari has no element fullscreen; the installed app is already
      // fullscreen there, so there is nothing to do.
    }
  };

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

  // A scanned pairing code connects straight away; returning false tells the
  // scanner the code was not a TailDeck one so it keeps looking.
  const handleScanResult = (raw: string): boolean => {
    const payload = decodePairing(raw);
    if (!payload) return false;
    triggerClick();
    setPairMode(null);
    linuxClient.connect(payload.h);
    onClose();
    return true;
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

  // Keystrokes go to the laptop as they are typed. The diff against the last
  // value we forwarded keeps backspace, autocorrect and paste all landing
  // correctly; a keyboard that only delivers on Enter is not a keyboard.
  const forwardedTextRef = useRef('');

  const handleQuickInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    const prev = forwardedTextRef.current;
    let p = 0;
    const max = Math.min(prev.length, next.length);
    while (p < max && prev[p] === next[p]) p++;
    for (let i = 0; i < prev.length - p; i++) {
      linuxClient.sendKeyCombo(['BackSpace']);
    }
    const added = next.slice(p);
    if (added) linuxClient.sendTypeText(added);
    forwardedTextRef.current = next;
    setQuickInput(next);
  };

  const handleQuickKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    linuxClient.sendKeyCombo(['Return']);
    forwardedTextRef.current = '';
    setQuickInput('');
  };

  // The public URL is stable. Interpolating window.location.origin put the
  // phone's or the laptop's private hotspot IP into every copy of this command.
  const REPO_URL = 'https://phy6.github.io/android-to-linux-remote';
  const GITHUB_URL = 'https://github.com/phy6/android-to-linux-remote';
  const DAEMON_URL = `${REPO_URL}/taildeck-daemon.py`;
  const INSTALL_URL = `${REPO_URL}/install.sh`;
  const installCommand = `curl -fsSL "${INSTALL_URL}" | bash`;
  const oneLinerCommand = `curl -sSL "${DAEMON_URL}" -o taildeck-daemon.py && python3 taildeck-daemon.py`;

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
              <p className="text-[11px] text-slate-400">Laptop remote control</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs: full width and tall, with the icon above the
            label, so they can be hit by feel without reading them. */}
        <div className="flex border-b border-slate-800 bg-slate-900/40">
          {(
            [
              { id: 'keys', label: 'Keyboard', Icon: Keyboard },
              { id: 'media', label: 'Media', Icon: Music },
              { id: 'tailscale', label: 'Connection', Icon: Wifi },
              { id: 'settings', label: 'Settings', Icon: Sliders },
              { id: 'help', label: 'Help', Icon: HelpCircle },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-3.5 font-medium transition-colors border-b-2 ${
                activeTab === id
                  ? 'border-sky-400 text-sky-400 bg-sky-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-xs">{label}</span>
            </button>
          ))}
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
                        ? 'Connected to laptop'
                        : connectionStatus.connecting
                        ? 'Connecting to laptop...'
                        : 'Disconnected'}
                    </div>
                    {connectionStatus.connected && connectionStatus.hostOsInfo && (
                      <div className="text-[11px] text-slate-400">
                        {connectionStatus.hostOsInfo.hostname} • {connectionStatus.hostOsInfo.session}
                      </div>
                    )}
                    <div
                      className={`text-[11px] ${
                        IS_LOCAL_MODE ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                      title={typeof location !== 'undefined' ? location.origin : ''}
                    >
                      {describeRoute(
                        connectionStatus.hostAddress,
                        IS_LOCAL_MODE,
                        connectionStatus.connected,
                      )}
                    </div>
                  </div>
                </div>

                {connectionStatus.connected && connectionStatus.latencyMs !== null && (
                  <div className="flex items-center gap-1 font-mono text-xs text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded-lg border border-emerald-800">
                    <Activity className="w-3 h-3" />
                    <span>{connectionStatus.latencyMs} ms</span>
                  </div>
                )}
              </div>

              {/* Saved laptops: remembered from past sessions, so switching
                  machines is one tap rather than retyping an address. */}
              {savedLaptops.length > 0 && (
                <div className="space-y-2">
                  <SectionTitle>My laptops</SectionTitle>
                  <div className="space-y-1.5">
                    {savedLaptops.map((laptop) => {
                      const isCurrent =
                        connectionStatus.hostAddress === laptop.host && connectionStatus.connected;
                      return (
                        <div
                          key={laptop.host}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900 border border-slate-800"
                        >
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold text-white truncate">
                              {laptop.name}
                            </div>
                            <div className="font-mono text-[10px] text-slate-500 truncate">
                              {laptop.host}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {isCurrent ? (
                              <span className="flex items-center gap-1 text-[10px] text-emerald-400 px-2 py-1 rounded-lg bg-emerald-950 border border-emerald-800">
                                <Check className="w-3 h-3" />
                                Connected
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  triggerClick();
                                  setTailscaleIp(laptop.host);
                                  linuxClient.connect(laptop.host);
                                }}
                                className="px-2.5 py-1.5 rounded-lg bg-sky-600 text-white text-[11px] font-medium hover:bg-sky-500"
                              >
                                Connect
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                triggerClick();
                                forgetSavedLaptop(laptop.host);
                              }}
                              title="Forget this laptop"
                              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-rose-300"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Address book: the daemon reports every way back to itself, so
                  you never have to run `tailscale ip` on the laptop. */}
              {connectionStatus.connected &&
                connectionStatus.hostOsInfo &&
                (connectionStatus.hostOsInfo.addresses?.length ||
                  connectionStatus.hostOsInfo.tailnet) && (
                  <div className="space-y-2">
                    <SectionTitle>Reach this laptop at</SectionTitle>
                    <div className="space-y-1.5">
                      {(connectionStatus.hostOsInfo.addresses ?? []).map((ip) => {
                        const port = connectionStatus.hostOsInfo?.ports?.https ?? 8443;
                        const value = `${ip}:${port}`;
                        const isCurrent =
                          connectionStatus.hostAddress.replace(/:\d+$/, '') === ip;
                        return (
                          <div
                            key={ip}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900 border border-slate-800"
                          >
                            <div className="min-w-0">
                              <div className="font-mono text-[11px] text-emerald-300 truncate">
                                {value}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                {isCurrent ? 'Connected now' : 'Same hotspot (LAN)'}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => copyToClipboard(value, `ip-${ip}`)}
                                title="Copy address"
                                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                              >
                                {copiedCode === `ip-${ip}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                              {!isCurrent && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTailscaleIp(value);
                                    linuxClient.connect(value);
                                  }}
                                  className="px-2.5 py-1.5 rounded-lg bg-sky-600 text-white text-[11px] font-medium hover:bg-sky-500"
                                >
                                  Use
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {connectionStatus.hostOsInfo.tailnet && (
                        <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                          <div className="min-w-0">
                            <div className="font-mono text-[11px] text-sky-300 truncate">
                              {connectionStatus.hostOsInfo.tailnet}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              Tailnet name (works on any network)
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(connectionStatus.hostOsInfo?.tailnet ?? '', 'tailnet')
                            }
                            title="Copy tailnet name"
                            className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 shrink-0"
                          >
                            {copiedCode === 'tailnet' ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              {/* IP Input Form */}
              <form onSubmit={handleConnect} className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Laptop address:
                  </label>
                  <input
                    type="text"
                    value={tailscaleIp}
                    onChange={(e) => setTailscaleIp(e.target.value)}
                    placeholder="e.g. my-laptop.tailnet.ts.net:8443"
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-sky-500"
                  />
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    On the same hotspot the app finds the laptop for you. Over Tailscale, use its
                    name like <code className="text-sky-400">my-laptop.tailnet.ts.net</code>.
                  </span>
                </div>

                {LOCAL_HOST && (
                  <button
                    type="button"
                    onClick={() => {
                      setTailscaleIp(LOCAL_HOST);
                      linuxClient.connect(LOCAL_HOST);
                    }}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30 transition"
                  >
                    <Wifi className="w-4 h-4" />
                    <span>Connect over the hotspot</span>
                  </button>
                )}

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
                    disabled={connectionStatus.connecting || !tailscaleIp.trim()}
                    className="w-full py-2.5 px-4 rounded-xl font-medium text-xs bg-sky-600 text-white hover:bg-sky-500 shadow-md shadow-sky-600/30 transition flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Wifi className="w-4 h-4" />
                    <span>
                      {connectionStatus.connecting
                        ? 'Connecting...'
                        : tailscaleIp.trim()
                          ? 'Connect to Laptop'
                          : 'Enter your laptop address'}
                    </span>
                  </button>
                )}
              </form>

              {/* QR pairing: the phone scans a code shown on the laptop, so
                  connecting never means typing an address. */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      triggerClick();
                      setPairMode('show');
                    }}
                    className="py-2.5 px-3 rounded-xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 transition"
                  >
                    <QrCode className="w-4 h-4 text-sky-400" />
                    <span>Show a code</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerClick();
                      setPairMode('scan');
                    }}
                    className="py-2.5 px-3 rounded-xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 transition"
                  >
                    <ScanLine className="w-4 h-4 text-emerald-400" />
                    <span>Scan a code</span>
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Show a code on the laptop, then scan it from the phone. Prefers the address that
                  skips the certificate warning.
                </p>
              </div>

              {/* The whole way in, on one screen: numbered codes for every route. */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    triggerClick();
                    onOpenSetup();
                  }}
                  className="w-full py-2.5 px-3 rounded-xl font-medium text-xs bg-sky-500/10 border border-sky-500/40 text-sky-200 hover:bg-sky-500/20 flex items-center justify-center gap-2 transition"
                >
                  <QrCode className="w-4 h-4 text-sky-300" />
                  <span>Setup &amp; QR codes</span>
                </button>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Every address this laptop answers on, as numbered codes. Opens by itself when the
                  app has no connection.
                </p>
              </div>

              {/* Prepare a machine that has never run TailDeck. Unlike the plain
                  one-liner below, this also sets up an input backend and a
                  service, so a friend's or spare laptop works on the first try
                  instead of connecting and then silently doing nothing. */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="font-semibold text-slate-300">Prepare a new laptop:</span>
                  <button
                    onClick={() => copyToClipboard(installCommand, 'install')}
                    className="flex items-center gap-1 text-sky-400 hover:text-sky-300"
                  >
                    {copiedCode === 'install' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedCode === 'install' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <div className="p-2.5 bg-slate-900 rounded-xl border border-slate-800 font-mono text-[11px] text-emerald-400 overflow-x-auto select-all">
                  {installCommand}
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  On any Linux laptop (a friend's, a spare): sets up input, downloads the daemon and
                  starts it on boot. Asks for sudo once. Then open the address it prints.
                </p>

                <details className="group">
                  <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-400 select-none">
                    Or just run it once, without installing
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] text-slate-500">
                      <span>run in the foreground</span>
                      <button
                        onClick={() => copyToClipboard(oneLinerCommand, 'cmd')}
                        className="flex items-center gap-1 text-sky-400 hover:text-sky-300"
                      >
                        {copiedCode === 'cmd' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedCode === 'cmd' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <div className="p-2.5 bg-slate-900 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-400 overflow-x-auto select-all">
                      {oneLinerCommand}
                    </div>
                  </div>
                </details>
              </div>

              {/* Download daemon link */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  <span className="text-xs text-slate-300">taildeck-daemon.py</span>
                </div>
                <a
                  href={DAEMON_URL}
                  download="taildeck-daemon.py"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 text-sky-400 text-xs font-medium hover:bg-slate-700 transition"
                >
                  <Download className="w-3 h-3" />
                  <span>Download</span>
                </a>
              </div>

              {/* Input method actually in use, straight from the daemon: the
                  backend differs per machine (uinput vs ydotool vs xdotool), so
                  a hard-coded claim would be wrong on some laptops. */}
              <div className="p-2.5 rounded-xl bg-sky-950/20 border border-sky-500/20 text-slate-400 text-[11px] flex items-start gap-2">
                <Shield className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <span>
                  {connectionStatus.connected && connectionStatus.hostOsInfo ? (
                    <>
                      Session{' '}
                      <code className="text-sky-300">{connectionStatus.hostOsInfo.session}</code>,
                      input via <code className="text-sky-300">{connectionStatus.hostOsInfo.backend}</code>.
                    </>
                  ) : (
                    <>
                      Works on X11 and Wayland (GNOME, KDE Plasma, Hyprland, Sway). Connect to see
                      the method in use.
                    </>
                  )}
                </span>
              </div>

              {/* Fingerprint unlock: enrol this phone as a passkey so it can
                  answer a challenge the laptop pushes. */}
              <UnlockPanel
                host={connectionStatus.hostAddress || tailscaleIp}
                connected={connectionStatus.connected}
              />
            </div>
          )}

          {/* TAB 2: REMOTE KEYBOARD & HOTKEYS */}
          {activeTab === 'keys' && (
            <div className="space-y-3 text-xs">
              {/* Live keyboard first, focused on open, so the phone's own
                  keyboard rises with the big buttons sitting ready above it.
                  Every keystroke is typed on the laptop as you press it; Enter
                  presses Return there. */}
              <div className="space-y-1">
                <input
                  ref={quickInputRef}
                  type="text"
                  value={quickInput}
                  onChange={handleQuickInput}
                  onKeyDown={handleQuickKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="Type here — it lands on the laptop live"
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-4 text-base text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono"
                />
                <p className="text-[10px] text-slate-500 px-1">
                  Sent as you type. Enter presses Return.
                </p>
              </div>

              {/* Linux Modifiers & Hotkeys */}
              <div className="grid grid-cols-3 gap-1.5 pt-1">
                <button
                  onClick={() => sendKey('Super_L')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-sky-400 font-bold active:scale-95 text-xs"
                >
                  SUPER (Win)
                </button>
                <button
                  onClick={() => sendKey('Escape')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  ESC
                </button>
                <button
                  onClick={() => sendKey('Tab')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  TAB
                </button>
                <button
                  onClick={() => sendKey('Control_L')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  CTRL
                </button>
                <button
                  onClick={() => sendKey('Alt_L')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 active:scale-95 text-xs"
                >
                  ALT
                </button>
                <button
                  onClick={() => sendKey('BackSpace')}
                  className="py-5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-rose-300 flex items-center justify-center active:scale-95"
                >
                  <Delete className="w-4 h-4" />
                </button>
              </div>

              {/* Media Controls */}
              <div className="flex items-center justify-around bg-slate-900/60 p-2 rounded-xl border border-slate-800">
                <button
                  onClick={() => sendKey('XF86AudioMute')}
                  className="p-4 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Mute"
                >
                  <VolumeX className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioLowerVolume')}
                  className="p-4 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Volume Down"
                >
                  <Volume1 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioRaiseVolume')}
                  className="p-4 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Volume Up"
                >
                  <Volume2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => sendKey('XF86AudioPlay')}
                  className="p-4 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Play / Pause"
                >
                  <Play className="w-4 h-4" />
                </button>
              </div>

              {/* Arrows & Enter */}
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => sendKey('Left')}
                  className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => sendKey('Up')}
                    className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => sendKey('Down')}
                    className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                </div>
                <button
                  onClick={() => sendKey('Right')}
                  className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>

                <button
                  onClick={() => sendKey('Return')}
                  className="px-5 py-6 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-medium flex items-center gap-1.5 text-sm active:scale-95 ml-2"
                >
                  <CornerDownLeft className="w-4 h-4" />
                  <span>ENTER</span>
                </button>
              </div>

              {/* Dark-out: paint the panel black so it reads as off, staying in
                  the foreground and awake so the laptop link never drops. */}
              <button
                type="button"
                onClick={onEnterDarkOut}
                className="w-full flex items-center justify-center gap-2 py-4 px-4 rounded-xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 active:scale-95 transition"
              >
                <Moon className="w-4 h-4 text-indigo-300" />
                <span>Dark-out — screen looks off</span>
              </button>

              {/* The floating mic is push-to-talk only, so the full dictation
                  sheet is opened from here instead. */}
              <button
                type="button"
                onClick={() => {
                  onOpenDictation();
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 py-5 px-4 rounded-xl font-medium text-sm bg-rose-600/90 text-white hover:bg-rose-500 active:scale-95 transition"
              >
                <Mic className="w-4 h-4" />
                <span>Open full dictation sheet</span>
              </button>
            </div>
          )}

          {/* TAB: MEDIA — transport and volume for whatever player the laptop
              has focused. Keys ride the same channel as the keyboard. */}
          {activeTab === 'media' && (
            <div className="space-y-4">
              <MediaNowCard now={nowPlaying} />
              <SectionTitle>Media controls</SectionTitle>
              <p className="text-xs text-slate-400">
                Drives whichever player is focused on the laptop — music, video,
                or a browser tab.
              </p>

              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    { action: 'prev', label: 'Previous', Icon: SkipBack },
                    { action: 'playpause', label: 'Play / Pause', Icon: Play },
                    { action: 'next', label: 'Next', Icon: SkipForward },
                  ] as const
                ).map(({ action, label, Icon }) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => pressMedia(action)}
                    className={`flex flex-col items-center justify-center gap-2 py-5 rounded-2xl font-medium text-xs border transition active:scale-95 ${
                      action === 'playpause'
                        ? 'bg-sky-600/90 border-sky-500 text-white hover:bg-sky-500'
                        : 'bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-6 h-6" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => pressMedia('stop')}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 active:scale-95 transition"
              >
                <Square className="w-4 h-4" />
                <span>Stop</span>
              </button>

              {/* YouTube ignores the media keys for the page player on some
                  setups; these send the site's own shortcuts (k / 0). */}
              <SectionTitle>YouTube</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    { action: 'yt_replay', label: 'Replay', Icon: Repeat2 },
                    { action: 'yt_playpause', label: 'Play / Pause', Icon: Play },
                  ] as const
                ).map(({ action, label, Icon }) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => pressMedia(action)}
                    className="flex flex-col items-center justify-center gap-2 py-5 rounded-2xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-200 hover:bg-slate-800 active:scale-95 transition"
                  >
                    <Icon className="w-6 h-6" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <SectionTitle>Volume</SectionTitle>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    { action: 'voldown', label: 'Quieter', Icon: Volume1 },
                    { action: 'mute', label: 'Mute', Icon: VolumeX },
                    { action: 'volup', label: 'Louder', Icon: Volume2 },
                  ] as const
                ).map(({ action, label, Icon }) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => pressMedia(action)}
                    className="flex flex-col items-center justify-center gap-2 py-5 rounded-2xl font-medium text-xs bg-slate-900 border border-slate-800 text-slate-200 hover:bg-slate-800 active:scale-95 transition"
                  >
                    <Icon className="w-6 h-6" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-5 text-xs">
              <section className="space-y-3">
                <SectionTitle>Pointer &amp; trackpad</SectionTitle>

                <div className="space-y-1.5">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5 text-sky-400" />
                    <span>Sensitivity: {settings.sensitivity.toFixed(1)}x</span>
                  </span>
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

                <div className="space-y-1.5">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Acceleration: {settings.acceleration.toFixed(2)}</span>
                  </span>
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

                <div className="space-y-1.5">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <Repeat2 className="w-3.5 h-3.5 text-sky-400" />
                    <span>App-switch distance: {settings.wheelSensitivity}px</span>
                  </span>
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

                <ToggleRow
                  icon={<MousePointerClick className="w-4 h-4 text-sky-400" />}
                  label="Tap to Click"
                  checked={settings.tapToClick}
                  onChange={(v) => onUpdateSettings({ tapToClick: v })}
                />
                <ToggleRow
                  icon={<MousePointer2 className="w-4 h-4 text-sky-400" />}
                  label="Two-Finger Right Click"
                  checked={settings.twoFingerRightClick}
                  onChange={(v) => onUpdateSettings({ twoFingerRightClick: v })}
                />
                <ToggleRow
                  icon={<MoveVertical className="w-4 h-4 text-sky-400" />}
                  label="Invert Scroll Direction"
                  checked={settings.invertScroll}
                  onChange={(v) => onUpdateSettings({ invertScroll: v })}
                />
              </section>

              <section className="space-y-3 pt-4 border-t border-slate-800">
                <SectionTitle>Feedback</SectionTitle>
                <ToggleRow
                  icon={<Vibrate className="w-4 h-4 text-sky-400" />}
                  label="Haptic Vibration"
                  checked={settings.hapticFeedback}
                  onChange={(v) => onUpdateSettings({ hapticFeedback: v })}
                />
                <ToggleRow
                  icon={<Volume2 className="w-4 h-4 text-indigo-400" />}
                  label="Click Sounds"
                  checked={settings.soundFeedback}
                  onChange={(v) => onUpdateSettings({ soundFeedback: v })}
                />
                <ToggleRow
                  icon={<Bell className="w-4 h-4 text-sky-400" />}
                  label="Connection notifications"
                  hint={
                    alertPermission === 'denied'
                      ? 'Blocked by the browser. Allow notifications for this site in your browser settings.'
                      : 'Posts a system notification when the link to your laptop comes up or drops.'
                  }
                  checked={settings.connectionAlerts}
                  onChange={async (v) => {
                    if (!v) {
                      onUpdateSettings({ connectionAlerts: false });
                      return;
                    }
                    const permission = await requestNotificationPermission();
                    onUpdateSettings({ connectionAlerts: permission === 'granted' });
                    setAlertPermission(permission);
                  }}
                />
              </section>

              <section className="space-y-3 pt-4 border-t border-slate-800">
                <SectionTitle>App</SectionTitle>
                <ToggleRow
                  icon={<Wifi className="w-4 h-4 text-sky-400" />}
                  label="Reconnect on open"
                  hint="The host address is remembered automatically once you connect."
                  checked={settings.autoConnect}
                  onChange={(v) => onUpdateSettings({ autoConnect: v })}
                />
                <ToggleRow
                  icon={<Wifi className="w-4 h-4 text-emerald-400" />}
                  label="Prefer hotspot link"
                  hint="Try the same-Wi-Fi link first, then fall back to Tailscale. Local needs the laptop's certificate accepted once."
                  checked={settings.preferLocal}
                  onChange={(v) => onUpdateSettings({ preferLocal: v })}
                />
                <ToggleRow
                  icon={<Maximize className="w-4 h-4 text-sky-400" />}
                  label="Full screen"
                  hint="Hides the browser chrome. Installed copies already open full screen."
                  checked={isFullscreen}
                  onChange={() => void toggleFullscreen()}
                />
              </section>

              <UpdatesPanel
                host={connectionStatus.hostAddress || tailscaleIp}
                connected={connectionStatus.connected}
                appUpdateReady={appUpdateReady}
                onApplyAppUpdate={onApplyAppUpdate}
              />

              <section className="space-y-3 pt-4 border-t border-slate-800">
                <SectionTitle>Developer</SectionTitle>

                <button
                  type="button"
                  onClick={() => {
                    onOpenDiagnostics();
                    onClose();
                  }}
                  className="w-full py-3.5 px-3 rounded-xl border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 font-medium transition"
                >
                  <Activity className="w-4 h-4 text-sky-400" />
                  <span>Dictation diagnostics</span>
                </button>

                <button
                  type="button"
                  onClick={onToggleSimulator}
                  className={`w-full py-3.5 px-3 rounded-xl border flex items-center justify-center gap-2 font-medium transition ${
                    isSimulatorActive
                      ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                      : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Monitor className="w-4 h-4" />
                  <span>{isSimulatorActive ? 'Hide Desktop Simulator' : 'Show Desktop Simulator'}</span>
                </button>
              </section>
            </div>
          )}

          {/* TAB 4: HELP & DOCS — one place for setup, gestures and the links */}
          {activeTab === 'help' && (
            <div className="space-y-4 text-xs">
              {/* Quick start */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Rocket className="w-4 h-4 text-sky-400" />
                  <SectionTitle>Quick start</SectionTitle>
                </div>
                <ol className="space-y-2">
                  {[
                    'Install TailDeck on the laptop you want to control (command below).',
                    'Put the phone and the laptop on the same Wi-Fi / hotspot, or both on Tailscale.',
                    'Connect from the Connection tab. The laptop is remembered for next time.',
                  ].map((step, i) => (
                    <li key={i} className="flex gap-2.5 p-3 rounded-xl bg-slate-900 border border-slate-800">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-500/40 text-sky-300 flex items-center justify-center text-[10px] font-semibold">
                        {i + 1}
                      </span>
                      <span className="text-slate-300 leading-snug">{step}</span>
                    </li>
                  ))}
                </ol>
              </section>

              {/* Set up a laptop */}
              <section className="space-y-3 pt-4 border-t border-slate-800">
                <SectionTitle>Set up a laptop</SectionTitle>
                <p className="text-[11px] text-slate-400 leading-snug">
                  One command installs the daemon, the input backend and a background service on
                  any Linux laptop. Run it on each machine you want to control.
                </p>
                <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">Laptop install</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(installCommand, 'help-install')}
                      className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                    >
                      {copiedCode === 'help-install' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedCode === 'help-install' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="px-3 py-2.5 overflow-x-auto text-[11px] text-emerald-300 font-mono whitespace-pre-wrap break-all">
                    {installCommand}
                  </pre>
                </div>
                <details className="rounded-xl bg-slate-900 border border-slate-800">
                  <summary className="px-3 py-2.5 cursor-pointer text-slate-300 font-medium">
                    Prefer to run the daemon yourself?
                  </summary>
                  <div className="px-3 pb-3 space-y-2">
                    <p className="text-[11px] text-slate-400 leading-snug">
                      Fetches just the daemon and runs it in the foreground. You provide the input
                      backend yourself.
                    </p>
                    <div className="rounded-lg bg-slate-950 border border-slate-800 overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">Manual</span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(oneLinerCommand, 'help-oneliner')}
                          className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                        >
                          {copiedCode === 'help-oneliner' ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>{copiedCode === 'help-oneliner' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <pre className="px-3 py-2.5 overflow-x-auto text-[11px] text-emerald-300 font-mono whitespace-pre-wrap break-all">
                        {oneLinerCommand}
                      </pre>
                    </div>
                  </div>
                </details>
              </section>

              {/* Using the deck */}
              <section className="space-y-2 pt-4 border-t border-slate-800">
                <SectionTitle>Using the deck</SectionTitle>
                <div className="space-y-1.5">
                  {[
                    ['Trackpad', 'Drag to move, tap to click, two fingers to scroll, two-finger tap to right-click.'],
                    ['Top bar', 'Swipe left / right to switch apps (Shift+Tab / Tab).'],
                    ['Bottom buttons', 'Left and right click. Hold the left button to start dictation.'],
                    ['Mic button', 'Hold to talk, release to type it. Drag the mic to move it.'],
                    ['Scripts & teleprompter', 'In dictation, pick a script from the laptop and press Scroll to read it as it glides; what is heard is shown below to check.'],
                    ['Media', 'The Media tab sends play / pause, track skip, and volume to whatever player the laptop has focused.'],
                    ['Notices from the laptop', 'On the laptop run: python3 taildeck-daemon.py notify "message" — it pops up on the phone while this app is open.'],
                    ['Resize', 'Long-press the right button, then drag up / down to size the big buttons.'],
                  ].map(([label, text]) => (
                    <div key={label} className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                      <div className="font-medium text-slate-200">{label}</div>
                      <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{text}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Connecting */}
              <section className="space-y-2 pt-4 border-t border-slate-800">
                <SectionTitle>Connecting</SectionTitle>
                <div className="space-y-1.5">
                  {[
                    ['Same hotspot', "Open the laptop's own https://<laptop>:8443/ once in the phone browser and accept the certificate warning, then connect here."],
                    ['Tailscale', 'Works with real certificates, so there is no warning to clear. Best when both are on your tailnet.'],
                    ['Control-only (http)', 'Keys and clicks work over http with no certificate. The screen stream needs https.'],
                  ].map(([label, text]) => (
                    <div key={label} className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                      <div className="font-medium text-slate-200">{label}</div>
                      <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{text}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Sharing with a guest */}
              <section className="space-y-2 pt-4 border-t border-slate-800">
                <SectionTitle>Let a guest drive</SectionTitle>
                <p className="text-[11px] text-slate-400 leading-snug">
                  The app is just a web page, so a friend can borrow it without installing anything.
                  They get the normal camera / microphone prompt once, and nothing is kept after
                  they close the tab.
                </p>
                <div className="space-y-1.5">
                  {[
                    ['Android guest', 'Open the laptop\'s https URL on the hotspot and accept the warning once. Works straight away.'],
                    ['iPhone guest — CA', 'iOS Safari refuses a self-signed socket. Install the laptop\'s CA once, then it works: open https://<laptop-ip>:8443/taildeck-ca.crt, Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > enable full trust.'],
                    ['iPhone guest — Tailscale', 'No certificate work: the guest installs Tailscale, you share the machine (Admin console > Machines > Share) and send the invite link. Real certificates, so Safari is happy.'],
                  ].map(([label, text]) => (
                    <div key={label} className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                      <div className="font-medium text-slate-200">{label}</div>
                      <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{text}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Troubleshooting */}
              <section className="space-y-2 pt-4 border-t border-slate-800">
                <div className="flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-amber-400" />
                  <SectionTitle>If something's off</SectionTitle>
                </div>
                <ul className="space-y-2">
                  {[
                    ["Connected but the laptop never reacts", "The input backend isn't running. Re-run the installer; on X11 it needs evdev / uinput, or a live ydotoold."],
                    ["The certificate warning won't clear", "Open the laptop's https URL directly (see Connecting) and accept it there, then come back."],
                    ['Dictation does nothing', 'The microphone needs an https page. Open the app from the hosted address or the laptop\'s https URL.'],
                    ['Right click feels late', 'It now fires on release, so a hold can resize. A quick tap still right-clicks.'],
                  ].map(([title, text]) => (
                    <li key={title} className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                      <div className="font-medium text-slate-200">{title}</div>
                      <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{text}</div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Links */}
              <section className="space-y-2 pt-4 border-t border-slate-800">
                <SectionTitle>Links</SectionTitle>
                <div className="space-y-1.5">
                  {[
                    ['Open the app', REPO_URL],
                    ['Source & issues', GITHUB_URL],
                    ['Daemon file', DAEMON_URL],
                    ['Installer', INSTALL_URL],
                  ].map(([label, url]) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300"
                    >
                      <span className="font-medium">{label}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <span className="truncate max-w-[150px]">{url.replace(/^https?:\/\//, '')}</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </span>
                    </a>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 px-1 pt-1">TailDeck {__BUILD_SHA__}</p>
              </section>
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

      {/* Pairing modals sit outside the drawer so they can cover the whole screen. */}
      <PairingCodeModal
        isOpen={pairMode === 'show'}
        onClose={() => setPairMode(null)}
        status={connectionStatus}
        hostname={connectionStatus.hostOsInfo?.hostname}
        onCopied={triggerClick}
      />
      <ScanPairingModal
        isOpen={pairMode === 'scan'}
        onClose={() => setPairMode(null)}
        onResult={handleScanResult}
      />
    </>
  );
};
