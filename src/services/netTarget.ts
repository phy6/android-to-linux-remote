// One place that decides what a "host" string means.
//
// Historically each client inferred the transport from the page scheme or from
// the port, in slightly different ways. That produced mismatches: an https page
// probed `https://host:8080`, while the socket dialled `ws://host:8080` and was
// refused as mixed content. Everything now goes through this parser, and an
// explicit scheme or port always wins.

export type TargetScheme = 'http' | 'https';

export interface HostTarget {
  /** The original string, trimmed. */
  raw: string;
  /** Hostname or IP literal, without brackets, scheme or port. */
  host: string;
  /** Explicit port, or null when the target relies on a default. */
  port: number | null;
  /** Explicit scheme from the input, or null when it has to be inferred. */
  scheme: TargetScheme | null;
}

export const DEFAULT_HTTPS_PORT = 8443;
export const DEFAULT_HTTP_PORT = 8080;

/** Parse `host`, `host:port`, `https://host:port/path`, `wss://…`. */
export function parseHostTarget(raw: string): HostTarget | null {
  const text = (raw || '').trim();
  if (!text) return null;

  let scheme: TargetScheme | null = null;
  let rest = text;
  const schemeMatch = /^(https?|wss?):\/\//i.exec(text);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase().startsWith('wss') || schemeMatch[1].toLowerCase() === 'https'
      ? 'https'
      : 'http';
    rest = text.slice(schemeMatch[0].length);
  }
  // Drop any path, query or fragment.
  rest = rest.split('/')[0].split('?')[0].split('#')[0];

  let host = rest;
  let port: number | null = null;

  // Bracketed IPv6 literal, optionally with a port.
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : null;
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      host = rest.slice(0, colon);
      port = Number(rest.slice(colon + 1));
    }
  }

  host = host.trim().toLowerCase();
  if (!host) return null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { raw: text, host, port, scheme };
}

/** `host` or `host:port`, for display and for the websocket status field. */
export function targetKey(target: HostTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return target.port === null ? host : `${host}:${target.port}`;
}

export function isAddressLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function pageIsSecure(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

/**
 * Whether to speak TLS. Rules, in order:
 *  1. an explicit `https://`/`wss://` or `http://`/`ws://` wins;
 *  2. port 80/8080 is plain, 443/the daemon's https port is TLS;
 *  3. otherwise follow the page (the deck served over https talks https).
 */
export function isSecureTarget(
  target: HostTarget,
  knownHttpsPort = DEFAULT_HTTPS_PORT,
  pageSecure = pageIsSecure(),
): boolean {
  if (target.scheme) return target.scheme === 'https';
  if (target.port !== null) {
    if (target.port === 80 || target.port === DEFAULT_HTTP_PORT) return false;
    if (target.port === 443 || target.port === knownHttpsPort) return true;
  }
  return pageSecure;
}

/** Base URL for REST calls. */
export function httpBase(
  target: HostTarget,
  knownHttpsPort = DEFAULT_HTTPS_PORT,
  pageSecure = pageIsSecure(),
): string {
  const secure = isSecureTarget(target, knownHttpsPort, pageSecure);
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${secure ? 'https' : 'http'}://${host}${target.port === null ? '' : `:${target.port}`}`;
}

/** Websocket URL for the same target. */
export function wsUrl(
  target: HostTarget,
  knownHttpsPort = DEFAULT_HTTPS_PORT,
  pageSecure = pageIsSecure(),
): string {
  const secure = isSecureTarget(target, knownHttpsPort, pageSecure);
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${secure ? 'wss' : 'ws'}://${host}${target.port === null ? '' : `:${target.port}`}`;
}

/**
 * True when the page cannot reach this target at all: an https page may not
 * fetch or open a plain-http/ws address. Callers should surface this as a
 * reason instead of letting the request fail opaquely.
 */
export function isMixedContentBlocked(
  target: HostTarget,
  knownHttpsPort = DEFAULT_HTTPS_PORT,
): boolean {
  return pageIsSecure() && !isSecureTarget(target, knownHttpsPort, true);
}

/** The daemon's https target for a plain host, used when a switch needs TLS. */
export function preferHttps(target: HostTarget, httpsPort = DEFAULT_HTTPS_PORT): HostTarget {
  if (isSecureTarget(target, httpsPort)) return target;
  return {
    raw: target.raw,
    host: target.host,
    port: target.port === DEFAULT_HTTP_PORT || target.port === null ? httpsPort : target.port,
    scheme: 'https',
  };
}
