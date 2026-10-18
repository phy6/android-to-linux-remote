// The laptop's shared folder, browsable from the phone.
//
// The daemon sandboxes one directory (@see SHARE_DIR, ~/taildeck-share) and
// exposes it as three REST endpoints: a listing, a download and a raw-body
// upload. Everything here is relative to that root — the daemon rejects
// absolute paths, '..' and dotfiles, so the phone only ever has to speak in
// share-relative names like "notes/idea.txt".

import { apiBase } from './scriptsClient';

export interface ShareEntry {
  name: string;
  /** Share-relative path, '/' separated. */
  path: string;
  dir: boolean;
  size: number;
  /** Unix seconds. */
  modified: number;
}

export interface ShareListing {
  dir: string;
  entries: ShareEntry[];
}

function cleanEntry(raw: unknown): ShareEntry | null {
  const e = raw as Partial<ShareEntry> | null;
  if (!e || typeof e.name !== 'string' || !e.name || typeof e.path !== 'string') {
    return null;
  }
  return {
    name: e.name,
    path: e.path,
    dir: !!e.dir,
    size: Number(e.size) || 0,
    modified: Number(e.modified) || 0,
  };
}

/** List one directory. Null when the laptop is unreachable or the path is refused. */
export async function listFiles(host: string, dir = ''): Promise<ShareListing | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    const res = await fetch(`${base}/api/files${query}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    return {
      dir: typeof data.dir === 'string' ? data.dir : dir,
      entries: (Array.isArray(data.entries) ? data.entries : [])
        .map(cleanEntry)
        .filter((e: ShareEntry | null): e is ShareEntry => e !== null),
    };
  } catch {
    return null;
  }
}

/** Fetch one file's bytes. Null when it is missing or refused. */
export async function downloadFile(host: string, path: string): Promise<Blob | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/files/download?path=${encodeURIComponent(path)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** Put one file into `dir` on the laptop, keeping the phone's own file name. */
export async function uploadFile(host: string, dir: string, file: File): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  const name = file.name.trim().replace(/[/\\]/g, '-');
  if (!name) return false;
  const target = [dir, name].filter(Boolean).join('/');
  try {
    const res = await fetch(`${base}/api/files/upload?path=${encodeURIComponent(target)}`, {
      method: 'POST',
      // text/plain keeps this a CORS "simple request" - no preflight needed.
      // The daemon writes the raw body and ignores the declared type.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: file,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Hand a Blob to the browser's downloader via a throwaway anchor. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
