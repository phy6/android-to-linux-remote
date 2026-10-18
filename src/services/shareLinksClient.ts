// Share links: hand one subfolder of the laptop's share to someone else, for a
// while, over a plain browser URL.
//
// The daemon keeps the link list (@see /api/shares) and serves the recipient's
// page under /s/<token>. The token is the secret; URLs are composed against the
// same origin the phone already talks to, so a link is http:// on the hotspot
// and https:// when the app came in over TLS. See plans/safe-share-links.md.

import { apiBase } from './scriptsClient';

export interface ShareLink {
  id: string;
  label: string;
  /** Share-relative folder the link opens; '' is the whole share. */
  dir: string;
  write: boolean;
  created: number;
  /** Unix seconds; 0 = never expires. */
  expires: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
  expired: boolean;
  exhausted: boolean;
  active: boolean;
  token: string;
  /** Path on the daemon, e.g. /s/<token>. */
  path: string;
}

export interface CreateShareOptions {
  dir?: string;
  write?: boolean;
  /** Seconds; 0 = never. */
  ttl?: number;
  /** 0 = unlimited, 1 = one-time pass. */
  maxUses?: number;
  label?: string;
}

function cleanLink(raw: unknown): ShareLink | null {
  const l = raw as Partial<ShareLink> | null;
  if (!l || typeof l.id !== 'string' || !l.id || typeof l.token !== 'string') return null;
  return {
    id: l.id,
    label: typeof l.label === 'string' ? l.label : '',
    dir: typeof l.dir === 'string' ? l.dir : '',
    write: !!l.write,
    created: Number(l.created) || 0,
    expires: Number(l.expires) || 0,
    maxUses: Number(l.maxUses) || 0,
    uses: Number(l.uses) || 0,
    revoked: !!l.revoked,
    expired: !!l.expired,
    exhausted: !!l.exhausted,
    active: !!l.active,
    token: l.token,
    path: typeof l.path === 'string' ? l.path : `/s/${l.token}`,
  };
}

/** The absolute URL a recipient opens. Null when the laptop is unreachable. */
export function shareUrl(host: string, link: Pick<ShareLink, 'path'>): string | null {
  const base = apiBase(host);
  return base ? `${base}${link.path}` : null;
}

export async function listShares(host: string): Promise<ShareLink[] | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/shares`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    return (Array.isArray(data.shares) ? data.shares : [])
      .map(cleanLink)
      .filter((l: ShareLink | null): l is ShareLink => l !== null);
  } catch {
    return null;
  }
}

async function postShare(host: string, path: string): Promise<ShareLink | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? cleanLink(data.share) : null;
  } catch {
    return null;
  }
}

export async function createShare(
  host: string,
  opts: CreateShareOptions,
): Promise<ShareLink | null> {
  const params = new URLSearchParams();
  if (opts.dir) params.set('dir', opts.dir);
  params.set('write', opts.write ? '1' : '0');
  params.set('ttl', String(opts.ttl ?? 0));
  params.set('maxUses', String(opts.maxUses ?? 0));
  if (opts.label) params.set('label', opts.label);
  return postShare(host, `/api/shares?${params.toString()}`);
}

export function renewShare(host: string, id: string, ttl: number): Promise<ShareLink | null> {
  return postShare(host, `/api/shares/${encodeURIComponent(id)}/renew?ttl=${ttl}`);
}

export async function revokeShare(host: string, id: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/shares/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteShare(host: string, id: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/shares/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
