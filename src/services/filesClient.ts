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

/**
 * Copy a file from one laptop's share into another's, brokered through the
 * phone (there is no laptop-to-laptop link). The bytes are held in phone memory
 * for the round trip, so this is bounded by the daemon's own upload ceiling —
 * anything larger is refused up front rather than buffered and rejected.
 */
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

export interface TransferResult {
  ok: boolean;
  filename: string;
  bytesTransferred: number;
  error?: string;
}

export async function transferFileViaPhone(
  sourceHost: string,
  targetHost: string,
  filePath: string,
  targetDir = '',
  opts: { onProgress?: (bytes: number) => void; maxBytes?: number } = {},
): Promise<TransferResult> {
  const filename = filePath.split('/').pop() || 'file';
  const maxBytes = opts.maxBytes ?? MAX_TRANSFER_BYTES;
  const base = apiBase(sourceHost);
  if (!base) return { ok: false, filename, bytesTransferred: 0, error: 'source unreachable' };
  try {
    const res = await fetch(`${base}/api/files/download?path=${encodeURIComponent(filePath)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, filename, bytesTransferred: 0, error: 'source file unavailable' };

    // Refuse before buffering when the source declares an oversized body.
    const declared = Number(res.headers.get('content-length') || '0');
    if (declared && declared > maxBytes) {
      void res.body?.cancel();
      return { ok: false, filename, bytesTransferred: 0, error: `too large (${declared} bytes)` };
    }

    const blob = await res.blob();
    if (blob.size > maxBytes) {
      return { ok: false, filename, bytesTransferred: 0, error: `too large (${blob.size} bytes)` };
    }
    opts.onProgress?.(blob.size);

    const file = new File([blob], filename, { type: blob.type });
    const ok = await uploadFile(targetHost, targetDir, file);
    return {
      ok,
      filename,
      bytesTransferred: ok ? blob.size : 0,
      error: ok ? undefined : 'upload failed',
    };
  } catch {
    return { ok: false, filename, bytesTransferred: 0, error: 'transfer failed' };
  }
}

export interface FolderTransferResult {
  ok: boolean;
  folder: string;
  filesTransferred: number;
  bytesTransferred: number;
  skipped: number;
  error?: string;
}

/** Guard against runaway recursion when mirroring a folder across hosts. */
export const MAX_FOLDER_FILES = 2000;

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

async function collectFiles(
  host: string,
  dir: string,
  out: ShareEntry[],
  limit: number,
): Promise<boolean> {
  const listing = await listFiles(host, dir);
  if (!listing) return false;
  for (const entry of listing.entries) {
    if (out.length >= limit) return false;
    if (entry.dir) {
      if (!(await collectFiles(host, entry.path, out, limit))) return false;
    } else {
      out.push(entry);
    }
  }
  return true;
}

/**
 * Copy a whole folder from one laptop's share into another's, brokered through
 * the phone. Recursively lists the source, then downloads and re-uploads each
 * file into the mirrored sub-path on the target (the daemon creates missing
 * parent directories on upload). Per-file `maxBytes` bounds phone memory; files
 * that are missing or oversized are skipped and counted rather than aborting
 * the whole copy.
 */
export async function transferFolderViaPhone(
  sourceHost: string,
  targetHost: string,
  folderPath: string,
  targetDir = '',
  opts: { onProgress?: (bytes: number, files: number) => void; maxBytes?: number; maxFiles?: number } = {},
): Promise<FolderTransferResult> {
  const folder = folderPath.split('/').filter(Boolean).pop() || 'folder';
  const result: FolderTransferResult = {
    ok: false,
    folder,
    filesTransferred: 0,
    bytesTransferred: 0,
    skipped: 0,
  };
  if (!apiBase(sourceHost)) {
    result.error = 'source unreachable';
    return result;
  }
  if (!apiBase(targetHost)) {
    result.error = 'target unreachable';
    return result;
  }
  const files: ShareEntry[] = [];
  const complete = await collectFiles(sourceHost, folderPath, files, opts.maxFiles ?? MAX_FOLDER_FILES);
  if (!complete) {
    result.error = 'folder too large or unreadable';
    return result;
  }
  if (files.length === 0) {
    result.ok = true;
    return result;
  }
  const maxBytes = opts.maxBytes ?? MAX_TRANSFER_BYTES;
  const destRoot = joinPath(targetDir, folder);
  for (const entry of files) {
    const rel = entry.path.slice(folderPath.length).replace(/^\//, '');
    const relDir = rel.split('/').slice(0, -1).join('/');
    const blob = await downloadFile(sourceHost, entry.path);
    if (!blob || blob.size > maxBytes) {
      result.skipped += 1;
      continue;
    }
    const file = new File([blob], entry.name, { type: blob.type });
    if (await uploadFile(targetHost, joinPath(destRoot, relDir), file)) {
      result.filesTransferred += 1;
      result.bytesTransferred += blob.size;
      opts.onProgress?.(result.bytesTransferred, result.filesTransferred);
    } else {
      result.skipped += 1;
    }
  }
  result.ok = result.skipped === 0;
  if (!result.ok) result.error = `${result.skipped} file(s) skipped`;
  return result;
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
