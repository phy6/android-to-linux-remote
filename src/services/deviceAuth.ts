// Device tokens for the laptop daemon.
//
// The daemon now requires a token on the websocket and on every mutating REST
// call. A token is issued once when a phone scans a pairing code and is stored
// here, never rendered. Keys are the daemon's stable id when known, with a
// host-name alias so REST calls made before `host_info` still find it.
//
// See plans/security-hardening.md.

import { parseHostTarget } from './netTarget';

const STORAGE_KEY = 'taildeck_device_tokens';

interface TokenStore {
  /** daemon key -> token. */
  tokens: Record<string, string>;
  /** hostname (no port) -> daemon key. */
  hosts: Record<string, string>;
  last?: string;
}

function emptyStore(): TokenStore {
  return { tokens: {}, hosts: {} };
}

function normalizeHost(raw: string): string {
  const target = parseHostTarget(raw);
  if (target) return target.host;
  return (raw || '').trim().toLowerCase();
}

function normalizeStore(parsed: Partial<TokenStore> | null | undefined): TokenStore {
  return {
    tokens: parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
    hosts: parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
    last: typeof parsed?.last === 'string' ? parsed.last : undefined,
  };
}

function readLocalStore(): TokenStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    return normalizeStore(JSON.parse(raw) as Partial<TokenStore>);
  } catch {
    return emptyStore();
  }
}

/**
 * The native shell keeps the token store outside localStorage. A WebView host
 * switch changes origin, so without this an origin would only know the token
 * for the laptop that served it. The shell is the origin-independent copy.
 */
function readShellStore(): TokenStore | null {
  try {
    const raw = window.TailDeckNative?.getDeviceTokens?.();
    if (!raw) return null;
    return normalizeStore(JSON.parse(raw) as Partial<TokenStore>);
  } catch {
    return null;
  }
}

function mergeStores(local: TokenStore, shell: TokenStore): TokenStore {
  // The shell copy is newer when both know the same key: another origin may
  // have re-paired the laptop since this page was loaded.
  const tokens = { ...local.tokens, ...shell.tokens };
  const hosts = { ...local.hosts, ...shell.hosts };
  return {
    tokens,
    hosts,
    last: shell.last ?? local.last ?? Object.keys(tokens)[0],
  };
}

function persistLocal(store: TokenStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled storage area must not break the connection.
  }
}

function mirrorToShell(store: TokenStore): void {
  try {
    window.TailDeckNative?.saveDeviceTokens?.(JSON.stringify(store));
  } catch {
    // The browser has no shell bridge; localStorage remains the whole store.
  }
}

function readStore(): TokenStore {
  return readLocalStore();
}

function writeStore(store: TokenStore): void {
  persistLocal(store);
  mirrorToShell(store);
}

// On load, copy the shell's origin-independent tokens into this origin so a
// host switch can immediately open background links to the laptop it left.
function hydrateFromShell(): void {
  if (typeof window === 'undefined') return;
  const bridge = window.TailDeckNative;
  if (
    !bridge ||
    (typeof bridge.getDeviceTokens !== 'function' &&
      typeof bridge.saveDeviceTokens !== 'function')
  ) {
    return;
  }
  const shell = readShellStore() ?? emptyStore();
  const local = readLocalStore();
  const merged = mergeStores(local, shell);
  persistLocal(merged);
  // Also seed the shell from a browser/local-only store on first run of this
  // build, so the next origin inherits what this one already knows.
  mirrorToShell(merged);
}

hydrateFromShell();

/** Remember a token returned by the daemon's `paired` message. */
export function saveDeviceToken(host: string, token: string, daemonId?: string): void {
  if (!token) return;
  const store = readStore();
  const key = daemonId ? `id:${daemonId}` : `host:${normalizeHost(host)}`;
  store.tokens[key] = token;
  if (daemonId) store.hosts[normalizeHost(host)] = key;
  store.last = key;
  writeStore(store);
}

/**
 * Re-key a token once the daemon tells us its stable id, so switching between
 * the LAN address and the tailnet name keeps working.
 */
export function rememberDaemonId(host: string, daemonId: string): void {
  if (!daemonId) return;
  const store = readStore();
  const hostKey = `host:${normalizeHost(host)}`;
  const idKey = `id:${daemonId}`;
  if (store.tokens[hostKey] && !store.tokens[idKey]) {
    store.tokens[idKey] = store.tokens[hostKey];
    delete store.tokens[hostKey];
  }
  if (store.tokens[idKey]) {
    store.hosts[normalizeHost(host)] = idKey;
    store.last = idKey;
    writeStore(store);
  }
}

/** Best token for a host string or URL. Null when this laptop is not paired. */
export function getDeviceToken(hostOrUrl: string): string | null {
  const store = readStore();
  const hostname = normalizeHost(hostOrUrl);
  const mapped = store.hosts[hostname];
  if (mapped && store.tokens[mapped]) return store.tokens[mapped];

  const direct = store.tokens[`host:${hostname}`];
  if (direct) return direct;

  // One paired laptop is the common case; with several, guessing would send
  // another laptop's token to this one. Wait for host_info to learn the id.
  const values = Object.values(store.tokens);
  return values.length === 1 ? values[0] : null;
}

/**
 * Token that is definitely mapped to this host. Background links use this:
 * with two saved laptops, falling back to the single stored token could send
 * one laptop's credential to another. The active socket can keep the looser
 * lookup because host_info immediately corrects a wrong id mapping.
 */
export function getDeviceTokenForHost(hostOrUrl: string): string | null {
  const store = readStore();
  const hostname = normalizeHost(hostOrUrl);
  const mapped = store.hosts[hostname];
  if (mapped && store.tokens[mapped]) return store.tokens[mapped];
  return store.tokens[`host:${hostname}`] ?? null;
}

export function forgetDeviceToken(host: string): void {
  const store = readStore();
  const hostname = normalizeHost(host);
  const key = store.hosts[hostname] || `host:${hostname}`;
  delete store.tokens[key];
  delete store.hosts[hostname];
  if (store.last === key) store.last = Object.keys(store.tokens)[0];
  writeStore(store);
}
