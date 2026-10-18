import React, { useState } from 'react';
import { Link2, Copy, Check, X, Loader2 } from 'lucide-react';
import { createShare, copyText, shareUrl, ShareLink } from '../services/shareLinksClient';

interface ShareLinkDialogProps {
  host: string;
  /** Share-relative folder the link will open; '' is the whole share. */
  dir: string;
  onClose: () => void;
  onCreated: () => void;
}

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 24 * 3600 },
  { label: '7 days', value: 7 * 24 * 3600 },
  { label: 'Never', value: 0 },
];

export const ShareLinkDialog: React.FC<ShareLinkDialogProps> = ({ host, dir, onClose, onCreated }) => {
  const [label, setLabel] = useState('');
  const [write, setWrite] = useState(false);
  const [ttl, setTtl] = useState(24 * 3600);
  const [oneTime, setOneTime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = created ? shareUrl(host, created) : null;

  const create = async () => {
    setBusy(true);
    setError(null);
    const link = await createShare(host, {
      dir,
      write,
      ttl,
      maxUses: oneTime ? 1 : 0,
      label: label.trim(),
    });
    setBusy(false);
    if (!link) {
      setError('Could not create the link. Is the laptop reachable?');
      return;
    }
    setCreated(link);
    onCreated();
  };

  const copy = async () => {
    if (!url) return;
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const optionBtn = (active: boolean) =>
    `flex-1 py-2 rounded-xl border text-xs font-medium transition-colors ${
      active
        ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-sm m-0 sm:m-4 rounded-t-2xl sm:rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm leading-tight">
                {created ? 'Link ready' : 'Share this folder'}
              </h3>
              <p className="text-[11px] text-slate-400 truncate max-w-[190px]">
                {dir ? dir : 'The whole share'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {created ? (
          <div className="p-4 space-y-3 text-xs">
            <p className="text-slate-400">
              Send this link to whoever needs the files. It opens in any browser — no app needed.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200">
                {url}
              </code>
              <button
                onClick={copy}
                className="p-2.5 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 shrink-0"
                title="Copy link"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              {created.write ? 'Read + upload' : 'Read-only'}
              {' · '}
              {created.expires === 0 ? 'no expiry' : 'expires with the time you chose'}
              {created.maxUses === 1 ? ' · usable once' : ''}
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 font-medium"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-4 text-xs">
            <div className="space-y-1.5">
              <span className="font-semibold text-slate-300">Label (optional)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Photos for Anna"
                className="w-full p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 placeholder:text-slate-600"
              />
            </div>

            <div className="space-y-1.5">
              <span className="font-semibold text-slate-300">They can</span>
              <div className="flex gap-2">
                <button onClick={() => setWrite(false)} className={optionBtn(!write)}>
                  View &amp; download
                </button>
                <button onClick={() => setWrite(true)} className={optionBtn(write)}>
                  Also upload
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="font-semibold text-slate-300">Expires</span>
              <div className="flex gap-2">
                {TTL_OPTIONS.map((o) => (
                  <button key={o.value} onClick={() => setTtl(o.value)} className={optionBtn(ttl === o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="font-semibold text-slate-300">Uses</span>
              <div className="flex gap-2">
                <button onClick={() => setOneTime(false)} className={optionBtn(!oneTime)}>
                  Anyone with the link
                </button>
                <button onClick={() => setOneTime(true)} className={optionBtn(oneTime)}>
                  One-time pass
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                A one-time pass lets the first person to open it browse and download, then it is done.
              </p>
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200">
                {error}
              </div>
            )}

            <button
              onClick={create}
              disabled={busy}
              className="w-full py-2.5 rounded-xl bg-sky-500 text-slate-950 font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Create link
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
