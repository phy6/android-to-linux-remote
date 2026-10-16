import { useCallback, useState } from 'react';

export interface SavedLaptop {
  /** The exact address that worked: an ip:port on the hotspot, or a tailnet name. */
  host: string;
  /** The daemon's hostname, shown as the friendly label. */
  name: string;
  /** Epoch ms of the last successful connection, for ordering. */
  last: number;
}

const STORAGE_KEY = 'taildeck_saved_laptops';
const MAX_LAPTOPS = 8;

export function loadSavedLaptops(): SavedLaptop[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is SavedLaptop => !!l && typeof l.host === 'string' && l.host.length > 0,
    );
  } catch {
    return [];
  }
}

function persist(list: SavedLaptop[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_LAPTOPS)));
  } catch {
    // Storage unavailable or full: the list is a convenience, never required state.
  }
}

/** Move this laptop to the front of the list, updating its name and timestamp. */
export function rememberLaptop(host: string, name: string): SavedLaptop[] {
  const clean = host.trim();
  if (!clean) return loadSavedLaptops();
  const label = name.trim() || clean;
  const rest = loadSavedLaptops().filter((l) => l.host !== clean);
  const next = [{ host: clean, name: label, last: Date.now() }, ...rest].slice(0, MAX_LAPTOPS);
  persist(next);
  return next;
}

export function forgetLaptop(host: string): SavedLaptop[] {
  const next = loadSavedLaptops().filter((l) => l.host !== host);
  persist(next);
  return next;
}

/** Live view of the saved laptops for a component, with refresh and forget. */
export function useSavedLaptops() {
  const [laptops, setLaptops] = useState<SavedLaptop[]>(() => loadSavedLaptops());
  const refresh = useCallback(() => setLaptops(loadSavedLaptops()), []);
  const forget = useCallback((host: string) => setLaptops(forgetLaptop(host)), []);
  return { laptops, refresh, forget };
}
