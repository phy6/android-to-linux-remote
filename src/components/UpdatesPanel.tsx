// "Updates" card: shows the phone app and the laptop daemon versions, checks
// the published release channel, and offers to update either side. The laptop
// update is gated: with a passkey enrolled the phone must confirm with a
// fingerprint; before one exists, an explicit confirm is enough.

import React, { useCallback, useEffect, useState } from 'react';
import { Laptop, RefreshCw, Smartphone } from 'lucide-react';
import {
  APP_SHA,
  APP_VERSION,
  UpdateCheck,
  UpdateResult,
  checkForUpdate,
  shortSha,
  updateLaptop,
} from '../services/version';
import { fetchAuthInfo, verifyWithPhone, webAuthnAvailable } from '../services/authClient';

interface UpdatesPanelProps {
  host: string;
  connected: boolean;
  appUpdateReady: boolean;
  onApplyAppUpdate: () => void;
}

const Row: React.FC<{
  icon: React.ReactNode;
  title: string;
  status: string;
  tone: 'ok' | 'stale' | 'muted';
  action?: { label: string; onClick: () => void; disabled?: boolean };
}> = ({ icon, title, status, tone, action }) => (
  <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-900 border border-slate-800">
    <div className="flex items-center gap-3 min-w-0">
      <span className="shrink-0 text-sky-400">{icon}</span>
      <div className="min-w-0">
        <p className="font-medium text-slate-200 truncate">{title}</p>
        <p
          className={`text-[11px] truncate ${
            tone === 'ok' ? 'text-emerald-400' : tone === 'stale' ? 'text-amber-400' : 'text-slate-500'
          }`}
        >
          {status}
        </p>
      </div>
    </div>
    {action && (
      <button
        type="button"
        onClick={action.onClick}
        disabled={action.disabled}
        className="shrink-0 px-3 py-2 rounded-lg bg-sky-500/15 border border-sky-500/40 text-sky-300 text-xs font-medium hover:bg-sky-500/25 disabled:opacity-40 disabled:hover:bg-sky-500/15 transition"
      >
        {action.label}
      </button>
    )}
  </div>
);

export const UpdatesPanel: React.FC<UpdatesPanelProps> = ({
  host,
  connected,
  appUpdateReady,
  onApplyAppUpdate,
}) => {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hasPasskey, setHasPasskey] = useState(false);

  const runCheck = useCallback(async () => {
    setBusy(true);
    try {
      const next = await checkForUpdate(connected ? host : undefined);
      setCheck(next);
      if (connected) {
        const info = await fetchAuthInfo(host);
        setHasPasskey(!!info?.credentials?.length);
      } else {
        setHasPasskey(false);
      }
    } finally {
      setBusy(false);
    }
  }, [host, connected]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const applyAppUpdate = onApplyAppUpdate;

  const applyLaptopUpdate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      let result: UpdateResult;
      if (hasPasskey) {
        if (!webAuthnAvailable()) {
          setMessage('Open the app from a domain over https to confirm with your phone.');
          return;
        }
        const verified = await verifyWithPhone(host);
        if (!verified.ok) {
          setMessage(verified.error === 'cancelled' ? 'Cancelled.' : verified.error || 'Could not verify.');
          return;
        }
        result = await updateLaptop(host, { requestId: verified.requestId });
      } else {
        const go = window.confirm(
          'Update TailDeck on the laptop now? The daemon will restart for a moment.',
        );
        if (!go) return;
        result = await updateLaptop(host, { confirm: true });
      }
      setMessage(result.ok ? `Laptop updated to ${result.to ?? 'the latest'}.` : result.error || 'Update failed.');
      await runCheck();
    } finally {
      setBusy(false);
    }
  };

  const appTone: 'ok' | 'stale' = check?.app.updateAvailable ? 'stale' : 'ok';
  const appStatus = check
    ? check.app.updateAvailable
      ? `Update available: ${check.app.latest} (${shortSha(check.app.latestSha)})`
      : 'Up to date'
    : 'Checking…';

  const laptopTone: 'ok' | 'stale' | 'muted' = !connected
    ? 'muted'
    : check?.laptop.updateAvailable
    ? 'stale'
    : 'ok';
  const laptopStatus = !connected
    ? 'Connect to a laptop to update it'
    : check?.laptop.reachable
    ? check.laptop.updateAvailable
      ? `Update available: ${check.laptop.latest}`
      : `Up to date${check.laptop.current ? ` (v${check.laptop.current})` : ''}`
    : 'Version unavailable';

  return (
    <section className="space-y-3 pt-4 border-t border-slate-800">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Updates</h4>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={busy}
          className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-40 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          <span>Check for updates</span>
        </button>
      </div>

      <Row
        icon={<Smartphone className="w-4 h-4" />}
        title={`TailDeck app v${APP_VERSION}`}
        status={appStatus}
        tone={appTone}
        action={
          check?.app.updateAvailable || appUpdateReady
            ? { label: 'Update app', onClick: () => void applyAppUpdate() }
            : undefined
        }
      />

      <Row
        icon={<Laptop className="w-4 h-4" />}
        title="Laptop software"
        status={laptopStatus}
        tone={laptopTone}
        action={{
          label: 'Update laptop',
          onClick: () => void applyLaptopUpdate(),
          disabled: busy || !connected,
        }}
      />

      <p className="text-[10px] text-slate-500 px-1">
        {hasPasskey ? 'A fingerprint confirms laptop updates.' : 'Pairing confirms laptop updates.'} App
        build {shortSha(APP_SHA)}.
        {check?.laptop.managed === false && connected ? ' Daemon is managed locally (app-only update).' : ''}
      </p>

      {message && <p className="text-[11px] text-sky-300 px-1">{message}</p>}
    </section>
  );
};
