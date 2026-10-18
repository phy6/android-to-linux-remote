import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Copy, Check, RefreshCw, Ban, Trash2 } from 'lucide-react';
import {
  listShares,
  renewShare,
  revokeShare,
  deleteShare,
  copyText,
  shareUrl,
  ShareLink,
} from '../services/shareLinksClient';

interface ShareLinksPanelProps {
  host: string;
  /** Bump to re-read the list (e.g. after creating a link). */
  refreshKey?: number;
}

const RENEW_TTL = 24 * 3600;

function expiryText(link: ShareLink): string {
  if (link.expires === 0) return 'no expiry';
  if (link.expired) return 'expired';
  const left = link.expires - Math.floor(Date.now() / 1000);
  if (left >= 3600) return `${Math.floor(left / 3600)}h left`;
  if (left >= 60) return `${Math.floor(left / 60)}m left`;
  return 'expiring now';
}

export const ShareLinksPanel: React.FC<ShareLinksPanelProps> = ({ host, refreshKey = 0 }) => {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listShares(host);
    setLinks(result ?? []);
    setLoaded(true);
  }, [host]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const copy = async (link: ShareLink) => {
    const url = shareUrl(host, link);
    if (!url) return;
    if (await copyText(url)) {
      setCopied(link.id);
      window.setTimeout(() => setCopied(null), 2000);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    await fn();
    await load();
    setBusy(null);
  };

  if (!loaded) return null;
  if (links.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-slate-800 text-[11px] text-slate-500">
        No share links yet. Tap the link button to hand someone a folder.
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-800 space-y-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Share links</h4>
      {links.map((link) => (
        <div
          key={link.id}
          className={`p-3 rounded-xl bg-slate-900 border ${
            link.active ? 'border-slate-800' : 'border-slate-800/60 opacity-70'
          }`}
        >
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 shrink-0">
              <Link2 className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-slate-100 truncate">
                {link.label || link.dir || 'Whole share'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {link.label && link.dir ? `${link.dir} · ` : ''}
                {link.write ? 'read + upload' : 'read-only'} · {expiryText(link)}
                {link.maxUses === 1 ? ' · one-time' : link.uses > 0 ? ` · used ${link.uses}` : ''}
                {link.revoked ? ' · revoked' : ''}
                {link.exhausted && !link.revoked ? ' · used up' : ''}
              </div>
            </div>
            <button
              onClick={() => copy(link)}
              className="p-2 rounded-lg bg-slate-800 text-slate-300 shrink-0"
              title="Copy link"
            >
              {copied === link.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            {!link.revoked && !link.exhausted && (
              <button
                onClick={() => act(link.id, () => renewShare(host, link.id, RENEW_TTL))}
                disabled={busy === link.id}
                className="p-2 rounded-lg bg-slate-800 text-sky-300 shrink-0 disabled:opacity-50"
                title="Renew 24h"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
            {link.active && (
              <button
                onClick={() => act(link.id, () => revokeShare(host, link.id))}
                disabled={busy === link.id}
                className="p-2 rounded-lg bg-slate-800 text-amber-300 shrink-0 disabled:opacity-50"
                title="Revoke"
              >
                <Ban className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => act(link.id, () => deleteShare(host, link.id))}
              disabled={busy === link.id}
              className="p-2 rounded-lg bg-slate-800 text-rose-300 shrink-0 disabled:opacity-50"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
