import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { X, Copy, Check, Smartphone, Wifi } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { PairingRoute, encodePairing, pairingRoutes } from '../services/pairing';
import { apiBase, apiFetch } from '../services/http';

interface PairingCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: ConnectionStatus;
  hostname?: string;
  onCopied?: () => void;
}

// Shown on the laptop: a QR the phone can scan to skip typing an address and to
// land on the route that avoids the certificate warning.
export const PairingCodeModal: React.FC<PairingCodeModalProps> = ({
  isOpen,
  onClose,
  status,
  hostname,
  onCopied,
}) => {
  const originHost = typeof location !== 'undefined' ? location.host : undefined;
  const routes = useMemo(() => pairingRoutes(status, originHost), [status, originHost]);
  const [routeId, setRouteId] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [codeError, setCodeError] = useState('');

  const activeRoute: PairingRoute | undefined =
    routes.find((r) => r.id === routeId) ?? routes[0];

  useEffect(() => {
    if (routes.length && !routes.some((r) => r.id === routeId)) {
      setRouteId(routes[0].id);
    }
  }, [routes, routeId]);

  // Mint a one-time code for the QR. It is spent when the phone pairs, so it is
  // refreshed every time the sheet opens. A connected laptop (or localhost)
  // can mint one; a first-run page that has not paired yet falls back to a v1
  // code and the hint below explains how to get a code.
  useEffect(() => {
    if (!isOpen || !activeRoute) return;
    let cancelled = false;
    setPairCode('');
    setCodeError('');
    const base = apiBase(activeRoute.host);
    if (!base) return;
    apiFetch(`${base}/api/pair/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'phone' }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && typeof data?.code === 'string' && data.code) {
          setPairCode(data.code);
        } else {
          setCodeError('Open this page on the laptop itself (localhost) once to mint a code.');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCodeError('Could not reach the daemon to mint a pairing code.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeRoute?.host]);

  useEffect(() => {
    if (!isOpen || !activeRoute) return;
    let cancelled = false;
    const text = encodePairing(activeRoute.host, hostname, pairCode || undefined);
    QRCode.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeRoute, hostname, pairCode]);

  useEffect(() => {
    setCopied(false);
  }, [activeRoute?.host]);

  if (!isOpen) return null;

  const copyHost = () => {
    if (!activeRoute) return;
    navigator.clipboard.writeText(activeRoute.host);
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-fadeIn" onClick={onClose} />

      <div className="relative w-full max-w-sm rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Smartphone className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm leading-tight">Pair a phone</h3>
              <p className="text-[11px] text-slate-400">Scan this from the app</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {routes.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">
            No reachable address yet. Open this page on the laptop you want to control, then try again.
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {routes.length > 1 && (
              <div className="space-y-1.5">
                {routes.map((route) => (
                  <button
                    key={route.id}
                    type="button"
                    onClick={() => setRouteId(route.id)}
                    className={`w-full text-left p-3 rounded-xl border transition ${
                      activeRoute?.id === route.id
                        ? 'bg-sky-500/10 border-sky-500/50'
                        : 'bg-slate-900 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
                      {route.id === 'tailscale' ? (
                        <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Wifi className="w-3.5 h-3.5 text-sky-400" />
                      )}
                      {route.label}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{route.hint}</div>
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-col items-center gap-3">
              <div className="rounded-2xl bg-white p-3">
                {dataUrl ? (
                  <img src={dataUrl} alt="Pairing QR code" width={260} height={260} className="block" />
                ) : (
                  <div className="w-[260px] h-[260px] flex items-center justify-center text-slate-400 text-xs">
                    Generating…
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={copyHost}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                <span className="font-mono">{activeRoute?.host}</span>
              </button>

              {codeError && (
                <p className="text-[11px] text-amber-400/90 text-center leading-snug">{codeError}</p>
              )}

              <p className="text-[11px] text-slate-500 text-center leading-snug">
                In the app, open <span className="text-slate-300">Connection → Scan a code</span>, then point the
                phone at this screen. This code works once and expires in five minutes.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
