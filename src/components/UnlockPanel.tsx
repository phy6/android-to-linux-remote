// "Unlock" card: enrols this phone's fingerprint as a passkey on the laptop and
// lists the ones already enrolled, so a registered phone can answer a challenge
// the laptop pushes.
//
// A relying-party id must be a real domain, so enrolment only works when the app
// is opened from its own web address (GitHub Pages, or the tailnet name) - a
// page loaded straight from the laptop's IP cannot create a passkey.

import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, KeyRound, ShieldAlert, Trash2, Unlock } from 'lucide-react';
import {
  AuthInfo,
  deleteCredential,
  fetchAuthInfo,
  registerPasskey,
  verifyWithPhone,
  webAuthnAvailable,
} from '../services/authClient';

interface UnlockPanelProps {
  host: string;
  connected: boolean;
}

const formatDate = (seconds?: number): string => {
  if (!seconds) return '';
  try {
    return new Date(seconds * 1000).toLocaleDateString();
  } catch {
    return '';
  }
};

export const UnlockPanel: React.FC<UnlockPanelProps> = ({ host, connected }) => {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canUse = webAuthnAvailable();

  const refresh = useCallback(async () => {
    if (!connected) {
      setInfo(null);
      return;
    }
    setInfo(await fetchAuthInfo(host));
  }, [host, connected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addPhone = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await registerPasskey(host, info?.user || '', 'This phone');
      if (!result.ok) {
        setMessage(result.error || 'Could not add this phone.');
        return;
      }
      setMessage('This phone can now unlock the laptop.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const removePhone = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const ok = await deleteCredential(host, id);
      if (!ok) {
        setMessage('Could not remove that key.');
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const unlockNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await verifyWithPhone(host, { user: info?.user || '' });
      if (!result.ok) {
        setMessage(
          result.error === 'cancelled'
            ? 'Unlock cancelled.'
            : result.error || 'Could not unlock the laptop.',
        );
        return;
      }
      setMessage('Approved — submit the lock screen within 30 seconds to unlock.');
    } finally {
      setBusy(false);
    }
  };

  const credentials = info?.credentials ?? [];

  return (
    <section className="space-y-3 pt-4 border-t border-slate-800">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Unlock</h4>
        {connected && info && (
          <span className="text-[10px] text-slate-500">
            {credentials.length
              ? `${credentials.length} ${credentials.length === 1 ? 'phone' : 'phones'} set up`
              : 'No phone set up'}
          </span>
        )}
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        Add this phone so its fingerprint can answer the laptop when it asks to be
        unlocked. Only the public half of the key leaves the phone.
      </p>

      {!canUse && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-amber-300 text-[11px]">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Open the app from its web address over https — not the laptop's IP — to
            set up a fingerprint. Passkeys need a real domain.
          </span>
        </div>
      )}

      {!connected && (
        <p className="text-[11px] text-slate-500">Connect to a laptop to set up unlock.</p>
      )}

      {connected && credentials.length > 0 && (
        <button
          type="button"
          onClick={() => void unlockNow()}
          disabled={busy || !canUse}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-xs bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:pointer-events-none transition"
        >
          <Unlock className="w-4 h-4" />
          <span>Unlock laptop now</span>
        </button>
      )}

      {connected && (
        <button
          type="button"
          onClick={() => void addPhone()}
          disabled={busy || !canUse}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-xs bg-sky-500/15 border border-sky-500/40 text-sky-300 hover:bg-sky-500/25 disabled:opacity-40 disabled:pointer-events-none transition"
        >
          <Fingerprint className="w-4 h-4" />
          <span>{credentials.length ? 'Add another phone' : 'Add this phone'}</span>
        </button>
      )}

      {connected && credentials.length > 0 && (
        <div className="space-y-1.5">
          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="flex items-center justify-between gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <KeyRound className="w-4 h-4 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-slate-200 truncate">
                    {cred.label || 'Phone'}
                  </p>
                  <p className="text-[10px] text-slate-500 truncate">
                    {cred.user || info?.user || 'user'}
                    {formatDate(cred.created) ? ` · added ${formatDate(cred.created)}` : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void removePhone(cred.id)}
                disabled={busy}
                title="Remove this phone"
                className="shrink-0 p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-rose-300 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {message && <p className="text-[11px] text-sky-300 px-1">{message}</p>}
    </section>
  );
};
