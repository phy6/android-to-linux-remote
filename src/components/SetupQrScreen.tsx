import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { X, Copy, Check, Wifi, ShieldCheck, Globe, ScanLine, RefreshCw } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { pairingRoutes, isTailnetIp } from '../services/pairing';

interface SetupQrScreenProps {
  isOpen: boolean;
  onClose: () => void;
  status: ConnectionStatus;
  /** Open the in-app scanner so the phone can read a code off another screen. */
  onScan?: () => void;
}

interface SetupStep {
  id: string;
  kind: 'ca' | 'connect';
  title: string;
  hint: string;
  value: string;
  recommended?: boolean;
}

const isIp = (host: string) => /^\d+\.\d+\.\d+\.\d+$/.test(host.split(':')[0]);

const QrImage: React.FC<{ text: string; size?: number }> = ({ text, size = 168 }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(text, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' })
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [text, size]);

  return (
    <div className="rounded-xl bg-white p-2 shrink-0" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" width={size} height={size} className="block w-full h-full" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-slate-400 text-[11px]">
          Generating…
        </div>
      )}
    </div>
  );
};

const StepCard: React.FC<{ step: SetupStep; index: number }> = ({ step, index }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(step.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const Icon = step.kind === 'ca' ? ShieldCheck : step.recommended ? Wifi : Globe;

  return (
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-3.5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="shrink-0 w-6 h-6 rounded-full bg-sky-500/20 border border-sky-500/40 text-sky-300 text-xs font-semibold flex items-center justify-center">
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <Icon className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="truncate">{step.title}</span>
              {step.recommended && (
                <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 rounded-full px-1.5 py-0.5">
                  Best
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{step.hint}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <QrImage text={step.value} />
        <button
          type="button"
          onClick={copy}
          className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 transition"
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </div>
          <span className="font-mono text-[11px] break-all">{step.value}</span>
        </button>
      </div>
    </div>
  );
};

/**
 * The whole setup, on one screen: scan a code and go. Numbered in the order a
 * fresh phone should do them. Shown automatically when the app has nothing to
 * talk to, so a dead link turns into a way back in instead of a dead end.
 */
export const SetupQrScreen: React.FC<SetupQrScreenProps> = ({ isOpen, onClose, status, onScan }) => {
  const originHost = typeof location !== 'undefined' ? location.host : undefined;
  const originProtocol = typeof location !== 'undefined' ? location.protocol : 'https:';
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const routes = useMemo(() => pairingRoutes(status, originHost), [status, originHost]);

  const steps = useMemo<SetupStep[]>(() => {
    const info = status.hostOsInfo;
    const httpPort = info?.ports?.http ?? 8080;
    const httpsPort = info?.ports?.https ?? 8443;
    const lanIps = (info?.addresses ?? []).filter((ip) => !isTailnetIp(ip));

    // The address the page itself is on, when that is a laptop rather than the
    // hosted copy. It is the only address available before host_info arrives.
    const originIp =
      originHost && isIp(originHost) && !/^127\./.test(originHost)
        ? originHost.split(':')[0]
        : null;

    const out: SetupStep[] = [];

    const tailscale = routes.find((r) => r.id === 'tailscale');
    if (tailscale) {
      out.push({
        id: 'tailscale',
        kind: 'connect',
        title: 'Connect over Tailscale',
        hint: 'Real certificate, works from anywhere on your tailnet. Installs as an app and needs no other step.',
        value: `https://${tailscale.host}/`,
        recommended: true,
      });
    }

    const lanIp = lanIps[0] ?? originIp;
    const startAt = tailscale ? 'same Wi-Fi.' : 'tailnet.';

    if (lanIp) {
      out.push({
        id: 'ca',
        kind: 'ca',
        title: 'Trust the certificate',
        hint: `Scan this to download the TailDeck CA, then open it and install it as a CA certificate. Needed once for the ${startAt}`,
        value: `http://${lanIp}:${httpPort}/taildeck-ca.crt`,
      });
      out.push({
        id: 'lan-https',
        kind: 'connect',
        title: 'Connect on the same Wi-Fi',
        hint: 'Encrypted link over the hotspot or local network, with the microphone. Do step above first.',
        value: `https://${lanIp}:${httpsPort}/`,
      });
      out.push({
        id: 'lan-http',
        kind: 'connect',
        title: 'Connect without the microphone',
        hint: 'Plain http: trackpad and keys work, but the browser blocks the mic here.',
        value: `http://${lanIp}:${httpPort}/`,
      });
    }

    // Any route we cannot express as an ip:port (a tailnet name reached as the
    // page origin, say) still deserves a code.
    for (const route of routes) {
      if (route.id === 'tailscale') continue;
      const url =
        route.id === 'origin' ? `${originProtocol}//${route.host}/` : `https://${route.host}/`;
      if (out.some((s) => s.value === url)) continue;
      out.push({
        id: route.id,
        kind: 'connect',
        title: route.label,
        hint: route.hint,
        value: url,
      });
    }

    return out;
  }, [routes, status.hostOsInfo, originHost, originProtocol]);

  useEffect(() => {
    if (!isOpen) return;
    // The overlay is portaled to <body> below, so the app root can be made
    // inert: no background focus targets and no stray screen-reader stops.
    // Declared before the focus effect so its cleanup lifts inert first.
    const root = document.getElementById('root');
    if (!root) return;
    const hadInert = root.hasAttribute('inert');
    const hadHidden = root.getAttribute('aria-hidden');
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      if (!hadInert) root.removeAttribute('inert');
      if (hadHidden === null) root.removeAttribute('aria-hidden');
      else root.setAttribute('aria-hidden', hadHidden);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const fallback = document.querySelector<HTMLElement>('button[aria-controls="taildeck-menu"]');
      const focusTarget = target && document.contains(target) ? target : fallback;
      focusTarget?.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const pill = status.connected
    ? { text: 'Connected', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' }
    : status.connecting
      ? { text: 'Connecting…', cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' }
      : { text: 'Not connected', cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/85 backdrop-blur-sm animate-fadeIn" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="taildeck-setup-title"
        className="relative w-full sm:max-w-md h-full sm:h-auto sm:max-h-[90vh] flex flex-col rounded-none sm:rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <RefreshCw className="w-4 h-4" />
            </div>
            <div>
              <h3 id="taildeck-setup-title" className="font-semibold text-white text-sm leading-tight">Set up this phone</h3>
              <p className="text-[11px] text-slate-400">Point the camera at a code below</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-medium border rounded-full px-2 py-0.5 ${pill.cls}`}>
              {pill.text}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {steps.length === 0 ? (
            <div className="text-center text-sm text-slate-400 py-8 leading-relaxed">
              No address to show yet. Open this app on the laptop you want to control
              (its address ends in <span className="text-slate-300">:8080</span>), and the
              codes will appear here.
            </div>
          ) : (
            steps.map((step, i) => <StepCard key={step.id} step={step} index={i} />)
          )}
        </div>

        {onScan && (
          <div className="p-4 pt-0 shrink-0">
            <button
              type="button"
              onClick={onScan}
              className="w-full py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 text-xs font-medium transition"
            >
              <ScanLine className="w-4 h-4 text-emerald-400" />
              <span>Instead, scan a code shown on the laptop</span>
            </button>
            <p className="text-[10px] text-slate-500 text-center mt-2 leading-relaxed">
              This screen opens by itself whenever the app has no connection.
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
