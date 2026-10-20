// One place that turns a laptop host into a REST base URL and attaches the
// device token. Feature clients used to each build their own base and call
// `fetch` directly; the daemon now rejects unauthenticated calls, so a single
// wrapper keeps the header (and the 401 behaviour) consistent.

import { getDeviceToken } from './deviceAuth';
import { httpBase, isMixedContentBlocked, parseHostTarget, preferHttps } from './netTarget';

/**
 * Base URL for REST calls against the laptop. Transport comes from the shared
 * target parser, so an explicit `:8443` stays TLS even on an http page. An
 * `http` target on an `https` page is moved to the daemon's TLS port instead:
 * the browser refuses mixed content, so calling it as written could only fail.
 * Callers with a saved laptop should resolve a full route first
 * (`services/hostRoutes.ts`) so alternates and transport preference are used.
 */
export function apiBase(host: string): string | null {
  const target = parseHostTarget(host);
  if (!target) return null;
  return httpBase(isMixedContentBlocked(target) ? preferHttps(target) : target);
}

/** `fetch` against a daemon URL, carrying the paired device token when known. */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getDeviceToken(url);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}

export function isUnauthorized(res: Response): boolean {
  return res.status === 401;
}
