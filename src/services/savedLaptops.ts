import { useCallback, useState } from 'react';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  isSecureTarget,
  parseHostTarget,
} from './netTarget';

export interface LastGoodRoute {
  /** host:port that last answered. */
  host: string;
  port: number | null;
  scheme: 'http' | 'https';
  /** Epoch ms. */
  at: number;
}

export interface SavedLaptop {
  /** The exact address that worked: an ip:port on the hotspot, or a tailnet name. */
  host: string;
  /** The daemon's hostname, shown as the friendly label. */
  name: string;
  /** Epoch ms of the last successful connection, for ordering. */
  last: number;
  /** Other same-hotspot addresses this laptop answered on last time (ip:port). */
  alt?: string[];
  /** The laptop's tailnet name, when it reported one. */
  tailnet?: string | null;
  /** Stable daemon identity, so a new address is still the same laptop. */
  id?: string;
  /** Leaf certificate fingerprint learned on first contact. */
  certSha256?: string | null;
  /** Interface kind that last worked (`wifi`, `usb`, `bluetooth`, …). */
  transport?: string;
  /** The route that most recently answered. */
  lastGood?: LastGoodRoute;
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
export function rememberLaptop(
  host: string,
  name: string,
  extra?: {
    alt?: string[];
    tailnet?: string | null;
    id?: string;
    certSha256?: string | null;
    transport?: string;
    lastGood?: LastGoodRoute;
  },
): SavedLaptop[] {
  const clean = host.trim();
  if (!clean) return loadSavedLaptops();
  const label = name.trim() || clean;
  const before = loadSavedLaptops();
  // A laptop that moved is the same laptop: match on the stable id first, then
  // on the address. Hostname-only comparison catches a connect made through an
  // alternate port/route (e.g. `:8080` -> `:8443`), which must not create a
  // second roster entry. Keeping the old address as an alternate lets the phone
  // try both until the new one is proven.
  const sameHostname = (a: string, b: string): boolean => {
    const ta = parseHostTarget(a);
    const tb = parseHostTarget(b);
    return !!ta && !!tb && ta.host === tb.host;
  };
  const previous = before.find(
    (l) =>
      (extra?.id && l.id === extra.id) ||
      l.host === clean ||
      sameHostname(l.host, clean) ||
      (l.alt ?? []).some((alt) => sameHostname(alt, clean)),
  );
  const rest = before.filter(
    (l) => l !== previous && l.host !== clean && !(extra?.id && l.id === extra.id),
  );
  const alt = Array.from(
    new Set(
      [clean, ...(extra?.alt ?? []), ...(previous?.alt ?? []), previous?.host ?? '']
        .map((value) => value.trim())
        .filter((value) => value && value !== clean),
    ),
  );
  const next = [
    {
      host: clean,
      name: label,
      last: Date.now(),
      alt,
      tailnet: extra?.tailnet ?? previous?.tailnet ?? null,
      id: extra?.id ?? previous?.id,
      certSha256: extra?.certSha256 ?? previous?.certSha256 ?? null,
      transport: extra?.transport ?? previous?.transport,
      lastGood: extra?.lastGood ?? previous?.lastGood,
    },
    ...rest,
  ].slice(0, MAX_LAPTOPS);
  persist(next);
  return next;
}

export function forgetLaptop(host: string): SavedLaptop[] {
  const next = loadSavedLaptops().filter((l) => l.host !== host);
  persist(next);
  return next;
}

/**
 * Merge an external roster (the native shell's) into the saved list, keeping the
 * newest entry per host and re-persisting. The shell owns the roster because
 * localStorage is per-origin and a host switch reloads the WebView at the new
 * origin, so without this each page would only ever remember itself.
 */
export function mergeSavedLaptops(incoming: SavedLaptop[]): SavedLaptop[] {
  const keyOf = (laptop: SavedLaptop) => laptop.id || laptop.host;
  const byKey = new Map<string, SavedLaptop>();
  for (const laptop of [...loadSavedLaptops(), ...incoming]) {
    if (!laptop || typeof laptop.host !== 'string' || !laptop.host) continue;
    const key = keyOf(laptop);
    const prev = byKey.get(key);
    byKey.set(
      key,
      prev
        ? {
            ...prev,
            ...laptop,
            alt: Array.from(new Set([...(prev.alt ?? []), ...(laptop.alt ?? [])])),
          }
        : laptop,
    );
  }
  const next = [...byKey.values()]
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    .slice(0, MAX_LAPTOPS);
  persist(next);
  return next;
}

/** One entry of the shell's origin-independent roster (`td_known_hosts`). */
interface ShellHostJson {
  host: string;
  name?: string;
  port?: number;
  isHttps?: boolean;
  last?: number;
  id?: string;
  certSha256?: string;
  transport?: string;
  alt?: string[];
}

/** Parse the shell's roster, if the bridge is present. */
export function readShellSavedLaptops(): SavedLaptop[] {
  try {
    const raw = window.TailDeckNative?.getSavedHosts?.();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const local = loadSavedLaptops();
    return parsed
      .filter(
        (l): l is ShellHostJson =>
          !!l && typeof (l as ShellHostJson).host === 'string' && (l as ShellHostJson).host.length > 0,
      )
      .map((entry) => {
        // The shell stores `host` and `port` separately; the page stores one
        // address string. Rebuild it, preferring the page's existing spelling so
        // the merge does not create a second entry for the same laptop.
        const parsedHost = parseHostTarget(entry.host);
        const hostName = parsedHost?.host ?? entry.host;
        const port =
          typeof entry.port === 'number' && entry.port > 0
            ? entry.port
            : parsedHost?.port ?? DEFAULT_HTTPS_PORT;
        const isHttps = entry.isHttps !== false;
        // Only reuse the page's spelling for the *same* address. A laptop that
        // moved keeps its id but not its old host, so the shell's newer address
        // must win there (the id-based merge collapses the two entries).
        const known = local.find((l) => {
          const t = parseHostTarget(l.host);
          return t?.host === hostName && (t.port ?? DEFAULT_HTTPS_PORT) === port;
        });
        const host =
          known?.host ?? `${hostName.includes(':') ? `[${hostName}]` : hostName}:${port}`;
        const last = typeof entry.last === 'number' ? entry.last : 0;
        const scheme: 'http' | 'https' = isHttps ? 'https' : 'http';
        return {
          host,
          name: entry.name?.trim() || host,
          last,
          alt: entry.alt ?? [],
          tailnet: null,
          id: entry.id || undefined,
          certSha256: entry.certSha256 || null,
          transport: entry.transport || undefined,
          lastGood: { host, port, scheme, at: last },
        };
      });
  } catch {
    return [];
  }
}

/** Push a laptop we just reached into the shell's roster (no-op in a browser). */
export function pushShellLaptop(laptop: SavedLaptop): void {
  try {
    // The shell keeps the address in two fields (`host` + `port` + `isHttps`),
    // unlike the page's single `host:port` string. Split it rather than guessing
    // from the last colon: a `:8080` laptop must stay plain http in the roster,
    // or the shell's next switch would dial TLS on the wrong port.
    const target = parseHostTarget(laptop.host);
    const lastTarget = laptop.lastGood ? parseHostTarget(laptop.lastGood.host) : null;
    const host = target?.host ?? laptop.host;
    const isHttps = laptop.lastGood?.scheme
      ? laptop.lastGood.scheme === 'https'
      : target
        ? isSecureTarget(target)
        : true;
    const port =
      laptop.lastGood?.port ??
      lastTarget?.port ??
      target?.port ??
      (isHttps ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
    window.TailDeckNative?.rememberHost?.(
      JSON.stringify({
        host,
        name: laptop.name,
        port,
        isHttps,
        last: laptop.last,
        id: laptop.id ?? '',
        certSha256: laptop.certSha256 ?? '',
        transport: laptop.transport ?? '',
        alt: laptop.alt ?? [],
      }),
    );
  } catch {
    // Best-effort: the shell roster is a convenience over the local list.
  }
}

/** Live view of the saved laptops for a component, with refresh and forget. */
export function useSavedLaptops() {
  const [laptops, setLaptops] = useState<SavedLaptop[]>(() => loadSavedLaptops());
  const refresh = useCallback(() => setLaptops(loadSavedLaptops()), []);
  const forget = useCallback((host: string) => setLaptops(forgetLaptop(host)), []);
  return { laptops, refresh, forget };
}
