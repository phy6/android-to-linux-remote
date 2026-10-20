import { ConnectionStatus } from '../types';
import { isNativeShell } from './localMode';

// Hosts that only serve the app itself; scanning/encoding them would pair the
// phone back to the hosted page instead of to a laptop.
const HOSTED_HOSTS = ['phy6.github.io'];
// Loopback is the app's own origin on a dev server, but it is the laptop when
// the native shell reaches it over a USB `adb reverse` tunnel.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

function originIsLaptop(originHost: string): boolean {
  if (HOSTED_HOSTS.some((h) => originHost.includes(h))) return false;
  if (LOOPBACK_HOSTS.some((h) => originHost.includes(h))) return isNativeShell();
  return true;
}

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
  /** 1 = address only (legacy), 2 = address + one-time pairing code. */
  v: 1 | 2;
  h: string;
  n?: string;
  /** One-time code the daemon exchanges for a per-phone device token. */
  c?: string;
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
  const transportLabel: Record<string, string> = {
    usb: 'USB tether',
    bluetooth: 'Bluetooth tether',
    wifi: 'Same Wi-Fi / hotspot',
    ethernet: 'Same network (cable)',
    network: 'Same network',
  };
  const transportHint: Record<string, string> = {
    usb: 'Wired, charging, lowest latency.',
    bluetooth: 'Low power; good for typing and dictation.',
    wifi: 'Self-signed certificate on the hotspot.',
    ethernet: 'Wired LAN.',
    network: 'Direct link.',
  };

  // Prefer the daemon's per-interface view: it already excludes container
  // bridges and tunnels, so every entry here is a route a phone might use.
  if (info?.interfaces?.length) {
    for (const link of info.interfaces) {
      if (!link?.address || isTailnetIp(link.address)) continue;
      const kind = link.transport || 'network';
      add(
        `${kind}-${link.address}`,
        transportLabel[kind] ?? transportLabel.network,
        transportHint[kind] ?? transportHint.network,
        `${link.address}:${httpsPort}`,
      );
    }
  } else {
    for (const ip of info?.addresses ?? []) {
      if (isTailnetIp(ip)) continue;
      add(
        `lan-${ip}`,
        'Same Wi-Fi / hotspot',
        'Self-signed certificate: the phone accepts the warning once.',
        `${ip}:${httpsPort}`,
      );
    }
  }

  // Names are only useful when the certificate covers them; advertising a
  // name that is absent from the SAN is what made `<hostname>.local` fail.
  const certNames = new Set((info?.certNames ?? []).map((name) => name.toLowerCase()));
  const candidates = new Set<string>();
  const byHost = mdnsHost(info?.hostname, httpsPort);
  if (byHost) candidates.add(byHost);
  const taildeckName = `taildeck.local:${httpsPort}`;
  candidates.add(taildeckName);
  for (const candidate of candidates) {
    const bare = candidate.replace(/:\d+$/, '').toLowerCase();
    if (!certNames.has(bare)) continue;
    add(
      `lan-name-${bare}`,
      'Same Wi-Fi, by name',
      'Follows the laptop when its address changes.',
      candidate,
    );
  }

  // Last resort when the daemon has not reported its addresses yet: the address
  // this page is itself being viewed on, as long as that is a laptop and not
  // the hosted copy.
  if (originHost && originIsLaptop(originHost)) {
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
  saved?: {
    host?: string;
    alt?: string[];
    tailnet?: string | null;
    name?: string;
    lastGood?: { host?: string };
  } | null;
  fallbackHost?: string;
  preferLocal: boolean;
  /** HTTPS port for the remembered `.local` name; defaults to 8443. */
  httpsPort?: number;
  /**
   * Pre-resolved addresses from `hostRoutes.routesForLaptop`, already ordered
   * most-direct-first and safe for the page's scheme. When present they lead
   * the list, so USB/LAN beats a stale last-good tailnet route.
   */
  routes?: string[];
}): string[] {
  const out: string[] = [];
  const add = (h?: string | null) => {
    const c = (h || '').trim();
    if (c && !out.includes(c)) out.push(c);
  };
  add(opts.localHost);
  if (opts.preferLocal) {
    // Resolved routes are already most-direct-first (USB, Ethernet, Wi-Fi,
    // mDNS, tailnet) and have had mixed content removed.
    (opts.routes ?? []).forEach(add);
    // The route that actually answered last is the strongest signal; the
    // alternates and the stable name follow.
    add(opts.saved?.lastGood?.host);
    (opts.saved?.alt ?? []).forEach(add);
    add(mdnsHost(opts.saved?.name, opts.httpsPort ?? 8443));
    add(opts.saved?.tailnet);
  } else {
    // The tailnet-first preference is deliberate (real certificate, works
    // away from the hotspot); direct routes are the fallback.
    add(opts.saved?.tailnet);
    (opts.routes ?? []).forEach(add);
  }
  add(opts.fallbackHost);
  add(opts.saved?.host);
  return out;
}

export function encodePairing(host: string, name?: string, code?: string): string {
  const payload: PairingPayload = code
    ? { t: 'taildeck', v: 2, h: host, c: code }
    : { t: 'taildeck', v: 1, h: host };
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
        const code = typeof obj.c === 'string' ? obj.c.trim() : '';
        return {
          t: 'taildeck',
          v: code ? 2 : 1,
          h: host,
          n: typeof obj.n === 'string' ? obj.n : undefined,
          c: code || undefined,
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
