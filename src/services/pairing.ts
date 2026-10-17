import { ConnectionStatus } from '../types';

// Hosts that only serve the app itself; scanning/encoding them would pair the
// phone back to the hosted page instead of to a laptop.
const HOSTED_HOSTS = ['phy6.github.io', 'localhost', '127.0.0.1'];

// Tailscale hands out CGNAT addresses (100.64.0.0/10); those are not reachable
// from a phone that is merely on the same hotspot.
export function isTailnetIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export interface PairingRoute {
  id: string;
  label: string;
  hint: string;
  /** The exact string to hand to linuxClient.connect (host, or ip:port). */
  host: string;
}

export interface PairingPayload {
  t: 'taildeck';
  v: 1;
  h: string;
  n?: string;
}

/**
 * The mDNS name a laptop publishes on its own network (Avahi), e.g.
 * `martin-hp-probook-6360b.local`. A DHCP change moves the ip but not the name,
 * so this is the cheapest way to survive a moved LAN address without Tailscale.
 * Null when the hostname is missing or is already something we should not append
 * `.local` to — an ip literal, a tailnet name, or a real domain.
 */
export function mdnsHost(hostname: string | null | undefined, httpsPort = 8443): string | null {
  const raw = (hostname || '').trim().toLowerCase();
  if (!raw) return null;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(raw);
  const isRealDomain = raw.includes('.') && !raw.endsWith('.local');
  if (isIpLiteral || isRealDomain) return null;
  const label = raw.endsWith('.local')
    ? raw
    : `${raw.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')}.local`;
  return `${label}:${httpsPort}`;
}

/**
 * Every address the phone could use to reach this laptop, best first. Tailscale
 * comes first because it carries a real certificate, so there is no warning to
 * clear; the LAN/hotspot addresses need the phone to accept the warning once.
 */
export function pairingRoutes(status: ConnectionStatus, originHost?: string): PairingRoute[] {
  const routes: PairingRoute[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, hint: string, host: string) => {
    const clean = (host || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    routes.push({ id, label, hint, host: clean });
  };

  const info = status.hostOsInfo;
  if (info?.tailnet) {
    add(
      'tailscale',
      'Tailscale',
      'Real certificate, works from anywhere on your tailnet.',
      info.tailnet,
    );
  }

  const httpsPort = info?.ports?.https ?? 8443;
  for (const ip of info?.addresses ?? []) {
    if (isTailnetIp(ip)) continue;
    add(
      `lan-${ip}`,
      'Same Wi-Fi / hotspot',
      'Self-signed certificate: the phone accepts the warning once.',
      `${ip}:${httpsPort}`,
    );
  }

  // By name, so it keeps working when the laptop's ip moves under it.
  const byName = mdnsHost(info?.hostname, httpsPort);
  if (byName) {
    add(
      'lan-name',
      'Same Wi-Fi, by name',
      'Follows the laptop when its ip changes (needs .local / mDNS resolution).',
      byName,
    );
  }

  // Last resort when the daemon has not reported its addresses yet: the address
  // this page is itself being viewed on, as long as that is a laptop and not
  // the hosted copy.
  if (originHost && !HOSTED_HOSTS.some((h) => originHost.includes(h))) {
    add('origin', 'This address', 'The address you are viewing this page on.', originHost);
  }

  return routes;
}

/**
 * The hosts to try, best first, when the app reconnects on its own. With
 * preferLocal the same-hotspot link comes first (fast, free of mobile data)
 * and the tailnet name is the fallback, so a self-signed link the phone has
 * not been taught still ends up on the working Tailscale route.
 */
export function autoconnectOrder(opts: {
  localHost?: string;
  saved?: { host?: string; alt?: string[]; tailnet?: string | null; name?: string } | null;
  fallbackHost?: string;
  preferLocal: boolean;
  /** HTTPS port for the remembered `.local` name; defaults to 8443. */
  httpsPort?: number;
}): string[] {
  const out: string[] = [];
  const add = (h?: string | null) => {
    const c = (h || '').trim();
    if (c && !out.includes(c)) out.push(c);
  };
  add(opts.localHost);
  if (opts.preferLocal) {
    (opts.saved?.alt ?? []).forEach(add);
    add(mdnsHost(opts.saved?.name, opts.httpsPort ?? 8443));
  }
  add(opts.saved?.tailnet);
  add(opts.fallbackHost);
  add(opts.saved?.host);
  return out;
}

export function encodePairing(host: string, name?: string): string {
  const payload: PairingPayload = { t: 'taildeck', v: 1, h: host };
  if (name) payload.n = name;
  return JSON.stringify(payload);
}

/**
 * Accepts a TailDeck payload, a full http(s) URL, or a bare host[:port] — the
 * three things a QR in the wild is likely to hold.
 */
export function decodePairing(raw: string): PairingPayload | null {
  const text = (raw || '').trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const host = typeof obj.h === 'string' ? obj.h.trim() : '';
      if (obj.t === 'taildeck' && host) {
        return {
          t: 'taildeck',
          v: 1,
          h: host,
          n: typeof obj.n === 'string' ? obj.n : undefined,
        };
      }
    } catch {
      // Not our JSON; fall through to the URL and host forms below.
    }
  }

  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      // Keep an explicit port; otherwise a bare host lets the client pick the
      // default for the page's own scheme.
      return { t: 'taildeck', v: 1, h: url.port ? `${url.hostname}:${url.port}` : url.hostname };
    }
  } catch {
    // Not a URL.
  }

  if (/^[A-Za-z0-9._-]+(:\d+)?$/.test(text)) {
    return { t: 'taildeck', v: 1, h: text };
  }

  return null;
}
