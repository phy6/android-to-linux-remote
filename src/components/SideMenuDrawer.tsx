import React, { useState, useRef, useEffect } from 'react';
import { ConnectionStatus, RemoteSettings, SessionType } from '../types';
import { linuxClient } from '../services/linuxClient';
import { LOCAL_HOST, IS_LOCAL_MODE, describeRoute } from '../services/localMode';
import { useSavedLaptops } from '../services/savedLaptops';
import { useHaptics } from '../hooks/useHaptics';
import { PWAInstallButton } from './PWAInstallButton';
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
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
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

interface SideMenuDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  connectionStatus: ConnectionStatus;
  settings: RemoteSettings;
  onUpdateSettings: (newSettings: Partial<RemoteSettings>) => void;
  onToggleSimulator: () => void;
  onOpenDictation: () => void;
  onOpenDiagnostics: () => void;
  isSimulatorActive: boolean;
  onEnterDarkOut: () => void;
}

export const SideMenuDrawer: React.FC<SideMenuDrawerProps> = ({
  isOpen,
  onClose,
  onOpen,
  connectionStatus,
  settings,
  onUpdateSettings,
  onToggleSimulator,
  onOpenDictation,
  onOpenDiagnostics,
  isSimulatorActive,
  onEnterDarkOut,
}) => {
  const { triggerClick } = useHaptics(settings.hapticFeedback, settings.soundFeedback);
  const {
    laptops: savedLaptops,
    refresh: refreshSavedLaptops,
    forget: forgetSavedLaptop,
  } = useSavedLaptops();
  const [tailscaleIp, setTailscaleIp] = useState(connectionStatus.hostAddress || '');
  const [alertPermission, setAlertPermission] = useState<AlertPermission>(notificationSupport());
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tailscale' | 'keys' | 'settings'>('keys');
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
              { id: 'tailscale', label: 'Connection', Icon: Wifi },
              { id: 'settings', label: 'Settings', Icon: Sliders },
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
                  icon={<Maximize className="w-4 h-4 text-sky-400" />}
                  label="Full screen"
                  hint="Hides the browser chrome. Installed copies already open full screen."
                  checked={isFullscreen}
                  onChange={() => void toggleFullscreen()}
                />

                <p className="text-[10px] text-slate-500 px-1">
                  TailDeck {__BUILD_SHA__}
                </p>
              </section>

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
