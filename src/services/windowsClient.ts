// The laptop's real Alt+Tab list, for the horizontal wheel.
//
// The daemon reads the X11 stacking order (top-most first) and matches each
// WM_CLASS to a .desktop entry, so the phone can show the actual running
// windows and their real icons. The wheel aggregates this list across every
// online laptop and focuses the exact window on the laptop that owns it.

import { apiBase, apiFetch } from './http';

export interface WindowEntry {
  /** X11 window id, e.g. `0x4800003`. Stable while the window exists. */
  id: string;
  title: string;
  /** Desktop-file id, or empty when the class matched no installed app. */
  appId: string;
  appName: string;
  wmClass: string;
  iconVersion: string;
  /** True for the focused window on that laptop. */
  active: boolean;
}

export interface WindowDevice {
  host: string;
  /** Compact label shown on the icon: HP, TMP, etc. */
  label: string;
  name: string;
  active: boolean;
}

export interface HostWindow extends WindowEntry {
  host: string;
  deviceLabel: string;
  deviceName: string;
  deviceActive: boolean;
  /** Unique across devices: the same X11 id can exist on both laptops. */
  key: string;
}

export interface WindowList {
  supported: boolean;
  reason: string;
  windows: WindowEntry[];
}

function cleanWindow(raw: unknown): WindowEntry | null {
  const w = raw as Partial<WindowEntry> | null;
  if (!w || typeof w.id !== 'string' || !w.id) return null;
  const title = typeof w.title === 'string' ? w.title : '';
  const appName =
    typeof w.appName === 'string' && w.appName
      ? w.appName
      : title || 'Window';
  return {
    id: w.id,
    title,
    appId: typeof w.appId === 'string' ? w.appId : '',
    appName,
    wmClass: typeof w.wmClass === 'string' ? w.wmClass : '',
    iconVersion: typeof w.iconVersion === 'string' ? w.iconVersion : '',
    active: w.active === true,
  };
}

/** One laptop's current Alt+Tab entries, top-most first. */
export async function fetchWindows(host: string): Promise<WindowList> {
  const base = apiBase(host);
  if (!base) return { supported: false, reason: 'invalid host', windows: [] };
  try {
    const res = await apiFetch(`${base}/api/windows`, { cache: 'no-store' });
    if (!res.ok) return { supported: false, reason: `HTTP ${res.status}`, windows: [] };
    const data = await res.json();
    const windows = Array.isArray(data?.windows)
      ? (data.windows as unknown[])
          .map(cleanWindow)
          .filter((w): w is WindowEntry => w !== null)
      : [];
    return {
      supported: data?.supported === true,
      reason: typeof data?.reason === 'string' ? data.reason : '',
      windows,
    };
  } catch (err) {
    return {
      supported: false,
      reason: err instanceof Error ? err.message : 'unreachable',
      windows: [],
    };
  }
}

/** Versioned icon URL for a window entry, or null when it has no known app. */
export function windowIconUrl(host: string, window: WindowEntry): string | null {
  const base = apiBase(host);
  if (!base || !window.appId || !window.iconVersion) return null;
  return `${base}/api/apps/icon?id=${encodeURIComponent(window.appId)}&v=${encodeURIComponent(
    window.iconVersion,
  )}`;
}

/** Raise one exact window on its laptop. Returns false when unsupported. */
export async function focusWindow(
  host: string,
  window: WindowEntry,
): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  try {
    // text/plain keeps this a CORS "simple request" (no preflight), matching
    // the scripts and app-launch calls.
    const res = await apiFetch(`${base}/api/windows/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ id: window.id, match: window.title }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}
