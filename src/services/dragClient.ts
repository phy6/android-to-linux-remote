// Cross-laptop drag broker.
//
// A desktop drag cannot leave the laptop where it started: the pointer grab and
// the XDND selection are local to that X server. When the phone carries the
// pointer over a screen edge with the button still held, it captures the live
// payload on the source laptop and copies it to the destination laptop through
// the phone. Only paths under the source's home directory are accepted by the
// daemon; this client mirrors folders with the same bounded, file-by-file model
// used by the share-folder transfer.

import { apiBase, apiFetch } from './http';

export interface DragEntry {
  name: string;
  /** Absolute source path on the laptop. */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
}

export interface DragPayload {
  ok: boolean;
  source?: 'xdnd' | 'clipboard' | 'primary' | null;
  entries: DragEntry[];
  error?: string;
}

export interface DragTransferResult {
  ok: boolean;
  files: number;
  folders: number;
  bytes: number;
  skipped: number;
  destination: string;
  error?: string;
}

export const MAX_DRAG_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DRAG_FILES = 2000;

function cleanEntry(raw: unknown): DragEntry | null {
  const e = raw as Partial<DragEntry> | null;
  if (!e || typeof e.name !== 'string' || typeof e.path !== 'string') return null;
  return {
    name: e.name,
    path: e.path,
    dir: !!e.dir,
    size: Number(e.size) || 0,
    modified: Number(e.modified) || 0,
  };
}

/** Read the live XDND/clipboard payload on the source laptop. */
export async function captureDragPayload(
  host: string,
  opts: { nudge?: boolean } = {},
): Promise<DragPayload> {
  const base = apiBase(host);
  if (!base) return { ok: false, entries: [], error: 'source unreachable' };
  try {
    // `nudge` tells the daemon to press Ctrl+C on the focused drag source when
    // the toolkit refuses to answer an XDND selection request mid-drag.
    const query = opts.nudge === false ? '' : '?nudge=1';
    const res = await apiFetch(`${base}/api/drag/payload${query}`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, entries: [], error: String(data?.error || 'drag unavailable') };
    }
    return {
      ok: true,
      source: typeof data.source === 'string' ? data.source : null,
      entries: (Array.isArray(data.entries) ? data.entries : [])
        .map(cleanEntry)
        .filter((e: DragEntry | null): e is DragEntry => e !== null),
    };
  } catch {
    return { ok: false, entries: [], error: 'drag capture failed' };
  }
}

interface DragInfo {
  targetDir: string;
}

async function fetchDragInfo(host: string): Promise<DragInfo | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await apiFetch(`${base}/api/drag/info`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return null;
    return { targetDir: String(data.targetDir || 'taildeck-share') };
  } catch {
    return null;
  }
}

async function listDragDir(host: string, dir: string): Promise<DragEntry[] | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await apiFetch(`${base}/api/drag/list?path=${encodeURIComponent(dir)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    return (Array.isArray(data.entries) ? data.entries : [])
      .map(cleanEntry)
      .filter((e: DragEntry | null): e is DragEntry => e !== null);
  } catch {
    return null;
  }
}

async function downloadDragFile(host: string, path: string): Promise<Blob | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await apiFetch(`${base}/api/drag/download?path=${encodeURIComponent(path)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

async function uploadDragFile(
  host: string,
  dir: string,
  name: string,
  blob: Blob,
): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  const query = new URLSearchParams({ dir, name });
  try {
    const res = await apiFetch(`${base}/api/drag/upload?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: blob,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function mkdirDragDir(host: string, dir: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  try {
    const res = await apiFetch(`${base}/api/drag/mkdir?dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function joinDir(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

async function copyDir(
  sourceHost: string,
  targetHost: string,
  sourceDir: string,
  targetDir: string,
  relDir: string,
  result: DragTransferResult,
  maxFiles: number,
): Promise<void> {
  const entries = await listDragDir(sourceHost, sourceDir);
  if (!entries) {
    result.skipped += 1;
    return;
  }
  for (const entry of entries) {
    if (result.files + result.folders >= maxFiles) {
      result.error = 'too many items';
      return;
    }
    const nextRel = joinDir(relDir, entry.name);
    if (entry.dir) {
      const dest = joinDir(targetDir, nextRel);
      if (await mkdirDragDir(targetHost, dest)) result.folders += 1;
      else {
        result.skipped += 1;
        continue;
      }
      await copyDir(sourceHost, targetHost, entry.path, targetDir, nextRel, result, maxFiles);
      continue;
    }
    if (entry.size > MAX_DRAG_FILE_BYTES) {
      result.skipped += 1;
      continue;
    }
    const blob = await downloadDragFile(sourceHost, entry.path);
    if (!blob || blob.size > MAX_DRAG_FILE_BYTES) {
      result.skipped += 1;
      continue;
    }
    const destDir = joinDir(targetDir, relDir);
    if (await uploadDragFile(targetHost, destDir, entry.name, blob)) {
      result.files += 1;
      result.bytes += blob.size;
    } else {
      result.skipped += 1;
    }
  }
}

/**
 * Copy the captured drag entries to the other laptop. Folders are recreated
 * (including empty ones), files are bounded by MAX_DRAG_FILE_BYTES, and the
 * whole set is capped by MAX_DRAG_FILES.
 */
export async function transferDragEntries(
  sourceHost: string,
  targetHost: string,
  entries: DragEntry[],
  opts: { maxFiles?: number; targetDir?: string } = {},
): Promise<DragTransferResult> {
  const result: DragTransferResult = {
    ok: false,
    files: 0,
    folders: 0,
    bytes: 0,
    skipped: 0,
    destination: '',
  };
  if (!apiBase(sourceHost)) {
    result.error = 'source unreachable';
    return result;
  }
  if (!apiBase(targetHost)) {
    result.error = 'target unreachable';
    return result;
  }
  const info = await fetchDragInfo(targetHost);
  const baseDir = opts.targetDir ?? info?.targetDir ?? 'taildeck-share';
  result.destination = baseDir;
  const maxFiles = opts.maxFiles ?? MAX_DRAG_FILES;

  for (const entry of entries) {
    if (result.files + result.folders >= maxFiles) {
      result.error = 'too many items';
      break;
    }
    if (entry.dir) {
      const dest = joinDir(baseDir, entry.name);
      if (await mkdirDragDir(targetHost, dest)) result.folders += 1;
      else {
        result.skipped += 1;
        continue;
      }
      await copyDir(sourceHost, targetHost, entry.path, baseDir, entry.name, result, maxFiles);
      continue;
    }
    if (entry.size > MAX_DRAG_FILE_BYTES) {
      result.skipped += 1;
      continue;
    }
    const blob = await downloadDragFile(sourceHost, entry.path);
    if (!blob || blob.size > MAX_DRAG_FILE_BYTES) {
      result.skipped += 1;
      continue;
    }
    if (await uploadDragFile(targetHost, baseDir, entry.name, blob)) {
      result.files += 1;
      result.bytes += blob.size;
    } else {
      result.skipped += 1;
    }
  }

  result.ok = !result.error && result.skipped === 0;
  return result;
}
