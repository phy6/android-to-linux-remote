// Installed GUI applications on the laptop, for the mic's shortcut panel.
//
// The daemon lists the .desktop entries and resolves their icon names to real
// files (@see /api/apps and /api/apps/icon). The list is small so it is cached
// in localStorage and refreshed silently; icons are referenced by a URL that
// carries the file's version, so a changed icon is a different URL and the
// browser's own cache does the "store locally, update when needed" part.

import { apiBase, apiFetch } from './http';

export interface AppEntry {
  id: string;
  name: string;
  comment: string;
  categories: string[];
  icon: string;
  iconVersion: string;
}

const LIST_KEY = 'taildeck_apps_cache_v1';
const FAV_KEY = 'taildeck_app_favourites';
const LIST_TTL_MS = 10 * 60 * 1000;

interface CachedList {
  host: string;
  fetchedAt: number;
  apps: AppEntry[];
}

function cleanApp(raw: unknown): AppEntry | null {
  const a = raw as Partial<AppEntry> | null;
  if (!a || typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name) {
    return null;
  }
  return {
    id: a.id,
    name: a.name,
    comment: typeof a.comment === 'string' ? a.comment : '',
    categories: Array.isArray(a.categories) ? a.categories.filter((c) => typeof c === 'string') : [],
    icon: typeof a.icon === 'string' ? a.icon : '',
    iconVersion: typeof a.iconVersion === 'string' ? a.iconVersion : '',
  };
}

function cleanList(raw: unknown): AppEntry[] {
  return (Array.isArray(raw) ? raw : [])
    .map(cleanApp)
    .filter((a): a is AppEntry => a !== null);
}

function readCache(host: string): CachedList | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIST_KEY) || 'null') as Partial<CachedList> | null;
    if (!parsed || parsed.host !== host) return null;
    return {
      host,
      fetchedAt: Number(parsed.fetchedAt) || 0,
      apps: cleanList(parsed.apps),
    };
  } catch {
    return null;
  }
}

/** The last list we saw for this laptop, or [] when there is nothing cached. */
export function cachedApps(host: string): AppEntry[] {
  return readCache(host)?.apps ?? [];
}

export function appsCacheAge(host: string): number {
  const cache = readCache(host);
  return cache ? Date.now() - cache.fetchedAt : Infinity;
}

/** Fetch from the laptop and replace the cache. Returns [] when offline. */
export async function fetchApps(host: string): Promise<AppEntry[]> {
  const base = apiBase(host);
  if (!base) return [];
  try {
    const res = await apiFetch(`${base}/api/apps`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const apps = cleanList(data?.apps);
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify({ host, fetchedAt: Date.now(), apps }));
    } catch {
      // Storage full or blocked; the panel simply refetches next time.
    }
    return apps;
  } catch {
    return [];
  }
}

/**
 * Cached list immediately, network in the background once it goes stale. The
 * caller gets a list straight away so the panel never waits on the laptop.
 */
export async function listApps(host: string): Promise<AppEntry[]> {
  const cache = readCache(host);
  if (cache && Date.now() - cache.fetchedAt < LIST_TTL_MS) return cache.apps;
  const fresh = await fetchApps(host);
  return fresh.length ? fresh : (cache?.apps ?? []);
}

export async function launchApp(host: string, id: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base || !id) return false;
  try {
    const res = await apiFetch(`${base}/api/apps/launch`, {
      method: 'POST',
      // text/plain keeps this a CORS "simple request" - no preflight needed.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Versioned icon URL, or null when the laptop has no icon for this app. The
 * version comes from the file's mtime+size, so it changes exactly when the
 * picture does.
 */
export function appIconUrl(host: string, app: AppEntry): string | null {
  const base = apiBase(host);
  if (!base || !app.iconVersion) return null;
  return `${base}/api/apps/icon?id=${encodeURIComponent(app.id)}&v=${encodeURIComponent(app.iconVersion)}`;
}

// --- Pinned favourites (phone-side) ----------------------------------------

// Seeded on first sight of a laptop so the panel is useful before the user has
// picked anything; ids are matched first, then display names.
const SEED_IDS = ['google-chrome', 'firefox', 'brave-browser'];
const SEED_NAMES = ['terminal', 'files', 'file manager', 'calculator', 'text editor'];

export function getFavourites(): string[] {
  const raw = rawFavourites();
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && !!id);
}

function rawFavourites(): unknown {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || 'null');
  } catch {
    return null;
  }
}

/** True once the user (or the seed below) has written a favourites list. */
function favouritesStored(): boolean {
  return Array.isArray(rawFavourites());
}

function writeFavourites(ids: string[]): string[] {
  const unique: string[] = [];
  for (const id of ids) if (id && !unique.includes(id)) unique.push(id);
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(unique));
  } catch {
    // Storage full or blocked; the favourites simply are not kept.
  }
  return unique;
}

export function toggleFavourite(id: string): string[] {
  const current = getFavourites();
  return writeFavourites(
    current.includes(id) ? current.filter((f) => f !== id) : [...current, id],
  );
}

export function isFavourite(id: string): boolean {
  return getFavourites().includes(id);
}

/** A sensible starter set, only used while the user has pinned nothing. */
export function seedFavourites(apps: AppEntry[]): string[] {
  const picked: string[] = [];
  for (const id of SEED_IDS) {
    if (apps.some((a) => a.id === id) && !picked.includes(id)) picked.push(id);
  }
  for (const needle of SEED_NAMES) {
    const hit = apps.find(
      (a) => a.name.toLowerCase().includes(needle) && !picked.includes(a.id),
    );
    if (hit) picked.push(hit.id);
    if (picked.length >= 6) break;
  }
  return picked.slice(0, 6);
}

/** Favourite ids resolved to entries, in the user's pin order, seeds included. */
export function favouriteApps(apps: AppEntry[]): AppEntry[] {
  const ids = favouritesStored()
    ? getFavourites()
    : (apps.length ? writeFavourites(seedFavourites(apps)) : []);
  const byId = new Map(apps.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is AppEntry => !!a);
}
