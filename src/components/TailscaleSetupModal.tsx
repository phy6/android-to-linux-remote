import React, { useState } from 'react';
import { ConnectionStatus, SessionType } from '../types';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import {
  Wifi,
  ShieldCheck,
  Download,
  Copy,
  Check,
  ExternalLink,
  Terminal,
  Activity,
  Layers,
  HelpCircle,
  X,
} from 'lucide-react';

interface TailscaleSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: ConnectionStatus;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
}

export const TailscaleSetupModal: React.FC<TailscaleSetupModalProps> = ({
  isOpen,
  onClose,
  status,
  hapticsEnabled,
  soundEnabled,
}) => {
  const { triggerClick } = useHaptics(hapticsEnabled, soundEnabled);
  const [tailscaleIp, setTailscaleIp] = useState(status.hostAddress || '');
  const [sessionType, setSessionType] = useState<SessionType>(status.sessionType || 'auto');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'connect' | 'daemon' | 'wayland_x11'>('connect');

  if (!isOpen) return null;

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    triggerClick();
    linuxClient.connect(tailscaleIp, sessionType);
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

  const oneLinerCommand = `curl -sSL "${window.location.origin}/taildeck-daemon.py" -o taildeck-daemon.py && python3 taildeck-daemon.py`;
  const systemdCommand = `cat << 'EOF' > ~/.config/systemd/user/taildeck.service
[Unit]
Description=TailDeck Remote Daemon (Wayland & X11)
After=network.target

[Service]
ExecStart=/usr/bin/python3 %h/taildeck-daemon.py
Restart=always

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now taildeck.service`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-xl bg-slate-900 border border-slate-700/80 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <Wifi className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base leading-tight">
                Tailscale & Linux Host Setup
              </h3>
              <p className="text-xs text-slate-400">
                Connect your Android device to your Linux laptop securely
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              triggerClick();
              onClose();
            }}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/50 px-4 pt-2 gap-2 text-xs">
          <button
            onClick={() => setActiveTab('connect')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 ${
              activeTab === 'connect'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Connect Host
          </button>
          <button
            onClick={() => setActiveTab('daemon')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 ${
              activeTab === 'daemon'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Linux Daemon
          </button>
          <button
            onClick={() => setActiveTab('wayland_x11')}
            className={`pb-2.5 px-3 font-medium transition-colors border-b-2 ${
              activeTab === 'wayland_x11'
                ? 'border-sky-400 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Wayland vs X11
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {activeTab === 'connect' && (
            <div className="space-y-4">
              {/* Connection Status Banner */}
              <div
                className={`p-3.5 rounded-2xl border flex items-center justify-between ${
                  status.connected
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                    : status.connecting
                    ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      status.connected
                        ? 'bg-emerald-400 animate-pulse'
                        : status.connecting
                        ? 'bg-amber-400 animate-ping'
                        : 'bg-slate-600'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">
                      {status.connected
                        ? 'Connected to Linux Laptop'
                        : status.connecting
                        ? 'Connecting...'
                        : 'Disconnected (Using Local Simulator)'}
                    </div>
                    {status.connected && status.hostOsInfo && (
                      <div className="text-[11px] text-slate-400">
                        {status.hostOsInfo.hostname} • {status.hostOsInfo.session} • {status.hostOsInfo.backend}
                      </div>
                    )}
                  </div>
                </div>

                {status.connected && status.latencyMs !== null && (
                  <div className="flex items-center gap-1 font-mono text-xs text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded-lg border border-emerald-800">
                    <Activity className="w-3 h-3" />
                    <span>{status.latencyMs} ms</span>
                  </div>
                )}
              </div>

              {/* Connect Form */}
              <form onSubmit={handleConnect} className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Linux Laptop Tailscale IP / Hostname:
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={tailscaleIp}
                      onChange={(e) => setTailscaleIp(e.target.value)}
                      placeholder="e.g. my-laptop.tailnet.ts.net:8080"
                      className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <span className="text-[11px] text-slate-500 mt-1 block">
                    Run <code className="text-sky-300 font-mono">tailscale ip -4</code> on your laptop to get your 100.x.y.z IP.
                  </span>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  {status.connected ? (
                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="flex-1 py-2.5 px-4 rounded-xl font-medium text-sm bg-rose-600/20 text-rose-300 border border-rose-500/40 hover:bg-rose-600/30 transition"
                    >
                      Disconnect Host
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={status.connecting}
                      className="flex-1 py-2.5 px-4 rounded-xl font-medium text-sm bg-sky-600 text-white hover:bg-sky-500 shadow-lg shadow-sky-600/30 transition flex items-center justify-center gap-2"
                    >
                      <Wifi className="w-4 h-4" />
                      <span>{status.connecting ? 'Connecting...' : 'Connect to Laptop'}</span>
                    </button>
                  )}
                </div>
              </form>

              {/* Tailscale quick steps */}
              <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 text-xs space-y-2">
                <div className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                  <span>How Tailscale Mesh Works:</span>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-slate-400 leading-relaxed text-[11px]">
                  <li>Both your Android device and Linux laptop run Tailscale.</li>
                  <li>They share an encrypted peer-to-peer WireGuard network with zero port forwarding required.</li>
                  <li>The Python daemon runs on your laptop on port 8080.</li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'daemon' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-300 leading-relaxed">
                Run this single-file Python script on your Linux laptop. It uses the Python standard library with zero mandatory pip dependencies:
              </div>

              {/* 1-Liner command */}
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="font-semibold">Quick Run Command:</span>
                  <button
                    onClick={() => copyToClipboard(oneLinerCommand, 'oneliner')}
                    className="flex items-center gap-1 text-sky-400 hover:text-sky-300"
                  >
                    {copiedCode === 'oneliner' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedCode === 'oneliner' ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-emerald-400 overflow-x-auto select-all">
                  {oneLinerCommand}
                </div>
              </div>

              {/* Download link */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  <span className="text-xs text-slate-300 font-medium">taildeck-daemon.py</span>
                </div>
                <a
                  href="/taildeck-daemon.py"
                  download="taildeck-daemon.py"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-500 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Script</span>
                </a>
              </div>

              {/* Systemd service */}
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="font-semibold">Optional: Auto-start on boot (systemd user service):</span>
                  <button
                    onClick={() => copyToClipboard(systemdCommand, 'systemd')}
                    className="flex items-center gap-1 text-sky-400 hover:text-sky-300"
                  >
                    {copiedCode === 'systemd' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedCode === 'systemd' ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto">
                  {systemdCommand}
                </pre>
              </div>
            </div>
          )}

          {activeTab === 'wayland_x11' && (
            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-2xl bg-sky-950/30 border border-sky-500/30 text-sky-200 leading-relaxed">
                <span className="font-semibold text-white block mb-1 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-sky-400" />
                  Full Compatibility Guaranteed: Wayland & X11
                </span>
                Unlike older remote trackpad tools that fail on modern Ubuntu, Fedora, Arch, or GNOME Wayland because X11 synthetic events are blocked, TailDeck uses Linux kernel <code className="text-sky-300 font-mono">/dev/uinput</code> or <code className="text-sky-300 font-mono">ydotool</code>.
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold text-white">How Each Environment is Handled:</h4>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                  <div className="font-semibold text-sky-400">1. Wayland (GNOME, KDE Plasma 6, Hyprland, Sway)</div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Uses virtual HID injection via <code className="text-slate-200">/dev/uinput</code>. This simulates a real USB/Bluetooth touchpad at the kernel layer, allowing cursor movement, clicks, and Alt+Tab program switching across all Wayland compositors without permissions issues.
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                  <div className="font-semibold text-emerald-400">2. X11 (Classic Desktops, XFCE, Mate, i3)</div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Works automatically using <code className="text-slate-200">/dev/uinput</code>, with automatic fallback to <code className="text-slate-200">xdotool</code> if installed.
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                  <div className="font-semibold text-amber-400">Permissions Tip (if required by your distro):</div>
                  <p className="text-slate-400 text-[11px]">
                    If your user does not have access to <code className="text-slate-200">/dev/uinput</code>, run:
                  </p>
                  <code className="block bg-slate-900 p-2 rounded text-emerald-400 font-mono text-[11px]">
                    sudo usermod -aG input $USER
                  </code>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
