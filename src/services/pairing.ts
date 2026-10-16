import { ConnectionStatus } from '../types';

// Hosts that only serve the app itself; scanning/encoding them would pair the
// phone back to the hosted page instead of to a laptop.
const HOSTED_HOSTS = ['phy6.github.io', 'localhost', '127.0.0.1'];

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
    add(
      `lan-${ip}`,
      'Same Wi-Fi / hotspot',
      'Self-signed certificate: the phone accepts the warning once.',
      `${ip}:${httpsPort}`,
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
