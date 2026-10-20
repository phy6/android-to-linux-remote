// One place that turns a saved laptop into concrete, reachable addresses.
//
// A saved laptop is an *identity* (id, name) with a history of addresses:
// the exact address that worked, alternates, an mDNS name and the tailnet name.
// Which of those is both reachable and most direct depends on the page and the
// network, so every caller that is about to talk to a laptop resolves a route
// here instead of guessing from a single `host:port` string.
//
// Ordering is "most direct first", not "most secure first":
//   USB (adb reverse / tether) > loopback > Bluetooth > Wi-Fi/hotspot >
//   Ethernet > unknown LAN > Tailscale > mDNS name.
// mDNS is last because Android WebView often cannot resolve `.local`; it stays
// as a fallback for a laptop whose only stable name is its hostname. This
// matches the native shell's ConnectionResolver ranking, so the page and the
// shell do not disagree about which link is preferred. The manual pairing list
// still puts Tailscale first for its real certificate; this module is for
// reconnecting to a laptop we already know.

import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parseHostTarget,
  type TargetScheme,
} from './netTarget';
import { isTailnetIp, mdnsHost } from './pairing';
import { isNativeShell } from './localMode';
import { loadSavedLaptops, type SavedLaptop } from './savedLaptops';

export type RouteTransport =
  | 'usb'
  | 'loopback'
  | 'ethernet'
  | 'wifi'
  | 'lan'
  | 'bluetooth'
  | 'mdns'
  | 'tailnet';

export type RouteSource = 'last-good' | 'saved' | 'alternate' | 'name' | 'tailnet';

export interface HostRoute {
  /** Address to hand to `linuxClient.connect` or a REST client. */
  host: string;
  hostname: string;
  port: number | null;
  scheme: TargetScheme;
  transport: RouteTransport;
  source: RouteSource;
  /** Lower is more direct; used for ordering only. */
  rank: number;
}

export interface RouteOptions {
  /** Defaults to the page's own scheme. */
  securePage?: boolean;
  /** The daemon's TLS port (reported in host_info), default 8443. */
  httpsPort?: number;
  /** The daemon's plain port, default 8080. */
  httpPort?: number;
  /** Loopback is the laptop only inside the native shell (adb reverse). */
  allowLoopback?: boolean;
}

const TRANSPORT_RANK: Record<RouteTransport, number> = {
  usb: 0,
  loopback: 0.5,
  bluetooth: 1,
  wifi: 2,
  ethernet: 3,
  lan: 3.5,
  tailnet: 9,
  mdns: 9.5,
};

const TRANSPORT_LABEL: Record<RouteTransport, string> = {
  usb: 'USB',
  loopback: 'USB',
  ethernet: 'Ethernet',
  wifi: 'Wi-Fi',
  lan: 'LAN',
  bluetooth: 'Bluetooth',
  mdns: 'LAN name',
  tailnet: 'Tailscale',
};

/** Human wording for the route badge in the UI. */
export function routeTransportLabel(route: HostRoute): string {
  return TRANSPORT_LABEL[route.transport] ?? 'Direct';
}

export function pageIsSecure(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

function classifyTransport(hostname: string, hint?: string | null): RouteTransport {
  const h = hostname.toLowerCase();
  if (isTailnetIp(hostname) || h.endsWith('.ts.net')) return 'tailnet';
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return 'loopback';
  if (h.endsWith('.local')) return 'mdns';
  if (hint === 'usb' || hint === 'ethernet' || hint === 'wifi' || hint === 'bluetooth') {
    return hint;
  }
  if (hint === 'network') return 'lan';
  return 'lan';
}

/** Address string for a host/port, bracketing IPv6 literals. */
export function formatRouteAddress(hostname: string, port: number | null): string {
  const h = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return port === null ? h : `${h}:${port}`;
}

interface ResolvedAddress {
  hostname: string;
  port: number | null;
  scheme: TargetScheme;
}

/**
 * Pick the scheme/port a page can actually use. An `https` page cannot fetch or
 * open a socket to `http`/`ws` (mixed content), so an http candidate is moved to
 * the daemon's TLS port instead of being handed to the browser to fail.
 */
function resolveAddress(raw: string, opts: Required<Pick<RouteOptions, 'securePage' | 'httpsPort' | 'httpPort'>>): ResolvedAddress | null {
  const target = parseHostTarget(raw);
  if (!target) return null;

  let scheme = target.scheme;
  if (!scheme) {
    if (target.port === 443 || target.port === opts.httpsPort) scheme = 'https';
    else if (target.port === 80 || target.port === opts.httpPort) scheme = 'http';
    else scheme = opts.securePage ? 'https' : 'http';
  }

  let port = target.port;
  if (opts.securePage && scheme === 'http') {
    // Same laptop, its TLS listener. This is the only form a secure page can use.
    scheme = 'https';
    port = opts.httpsPort;
  }

  return { hostname: target.host, port, scheme };
}

function normalizeOptions(opts: RouteOptions = {}): Required<Omit<RouteOptions, 'allowLoopback'>> & {
  allowLoopback: boolean;
} {
  return {
    securePage: opts.securePage ?? pageIsSecure(),
    httpsPort: opts.httpsPort ?? DEFAULT_HTTPS_PORT,
    httpPort: opts.httpPort ?? DEFAULT_HTTP_PORT,
    allowLoopback: opts.allowLoopback ?? isNativeShell(),
  };
}

/**
 * Every usable address for one saved laptop, most direct first. Addresses that
 * resolve to the same scheme/host/port are collapsed, keeping the best rank.
 */
export function routesForLaptop(laptop: SavedLaptop, options: RouteOptions = {}): HostRoute[] {
  const opts = normalizeOptions(options);
  const preferredScheme: TargetScheme = opts.securePage ? 'https' : 'http';
  const byAddress = new Map<string, HostRoute>();

  const add = (raw: string | null | undefined, source: RouteSource, hint?: string | null) => {
    const clean = (raw ?? '').trim();
    if (!clean) return;
    const resolved = resolveAddress(clean, opts);
    if (!resolved) return;
    const transport = classifyTransport(resolved.hostname, hint);
    // A loopback address is the phone itself unless the shell tunnelled it.
    if (transport === 'loopback' && !opts.allowLoopback) return;

    const address = formatRouteAddress(resolved.hostname, resolved.port);
    const rank =
      TRANSPORT_RANK[transport] +
      (resolved.scheme === preferredScheme ? 0 : 0.25) +
      (source === 'last-good' ? -0.25 : 0);
    const route: HostRoute = {
      host: address,
      hostname: resolved.hostname,
      port: resolved.port,
      scheme: resolved.scheme,
      transport,
      source,
      rank,
    };
    const existing = byAddress.get(address);
    if (!existing || rank < existing.rank) byAddress.set(address, route);
  };

  // The route that actually answered last is a hint, not a guarantee: directness
  // still decides, so a USB address beats a Wi-Fi last-good.
  add(laptop.lastGood?.host, 'last-good', laptop.transport);
  add(laptop.host, 'saved', laptop.transport);
  // Alternates do not record which interface they came from, so they are
  // classified from the address alone (LAN unless they are a tailnet/mDNS name).
  // Reusing `laptop.transport` here would label every alternate as the last
  // transport that happened to work.
  for (const alt of laptop.alt ?? []) add(alt, 'alternate');
  add(mdnsHost(laptop.name, opts.httpsPort), 'name');
  add(laptop.tailnet, 'tailnet', 'tailnet');

  return [...byAddress.values()].sort((a, b) => a.rank - b.rank || a.host.localeCompare(b.host));
}

/** The route to try first, or null when every known address is unusable here. */
export function bestLaptopRoute(laptop: SavedLaptop, options: RouteOptions = {}): HostRoute | null {
  return routesForLaptop(laptop, options)[0] ?? null;
}

/** Resolve a bare address (no roster context), upgrading mixed content. */
export function routeForAddress(host: string, options: RouteOptions = {}): HostRoute | null {
  const opts = normalizeOptions(options);
  const resolved = resolveAddress(host, opts);
  if (!resolved) return null;
  const transport = classifyTransport(resolved.hostname);
  if (transport === 'loopback' && !opts.allowLoopback) return null;
  return {
    host: formatRouteAddress(resolved.hostname, resolved.port),
    hostname: resolved.hostname,
    port: resolved.port,
    scheme: resolved.scheme,
    transport,
    source: 'saved',
    rank: TRANSPORT_RANK[transport],
  };
}

/**
 * Best address for a saved identity, or the input unchanged when it is unknown.
 * For callers that hold only an address string (file transfer targets, legacy
 * settings) but should still use the direct route and avoid mixed content.
 */
export function bestAddressForSaved(host: string, laptops?: SavedLaptop[]): string {
  const list = laptops ?? loadSavedLaptops();
  const laptop = findLaptopForAddress(host, list);
  return (laptop && bestLaptopRoute(laptop)?.host) || host;
}

export interface HostIdentityInfo {
  id?: string;
  hostname?: string;
  addresses?: string[];
  tailnet?: string | null;
}

/** Fold a connected route address (hotspot, tailnet, last-good) back to the
 * saved laptop identity that owns it. The live `hostOsInfo` is a second signal:
 * when the page is served by the daemon on loopback but the saved identity was
 * learned on the LAN, the addresses/id still identify the same laptop. Falls
 * back to the address when it has not been remembered yet. */
export function savedIdentityFor(
  address: string | undefined,
  laptops: SavedLaptop[],
  info?: HostIdentityInfo,
): string {
  if (!address) return '';
  const direct = findLaptopForAddress(address, laptops);
  if (direct) return direct.host;
  if (info?.id) {
    const byId = laptops.find((laptop) => laptop.id && laptop.id === info.id);
    if (byId) return byId.host;
  }
  for (const candidate of [info?.tailnet ?? '', ...(info?.addresses ?? [])]) {
    if (!candidate) continue;
    const match = findLaptopForAddress(candidate, laptops);
    if (match) return match.host;
  }
  if (info?.hostname) {
    const byName = laptops.find(
      (laptop) => laptop.name === info.hostname || parseHostTarget(laptop.host)?.host === info.hostname,
    );
    if (byName) return byName.host;
  }
  return address;
}

/** Find the saved identity behind an address (host, alternate or last-good). */
export function findLaptopForAddress(
  address: string,
  laptops: SavedLaptop[],
): SavedLaptop | null {
  const target = parseHostTarget(address);
  if (!target) return null;
  return (
    laptops.find((l) => {
      const addresses = [l.host, l.lastGood?.host ?? '', l.tailnet ?? '', ...(l.alt ?? [])];
      if (
        addresses.some((candidate) => {
          const t = parseHostTarget(candidate);
          return !!t && t.host === target.host;
        })
      ) {
        return true;
      }
      // `routesForLaptop` generates the mDNS name from the label; without this
      // a switch through `<name>.local` would not fold back to the saved
      // identity and the old host's info would look like the new one.
      const mdns = parseHostTarget(mdnsHost(l.name) ?? '');
      return !!mdns && mdns.host === target.host;
    }) ?? null
  );
}
