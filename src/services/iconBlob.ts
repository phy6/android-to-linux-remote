// App icons need the device token, and an <img src> cannot send an
// Authorization header. Fetch the icon through the authenticated client once,
// then hand the <img> a blob URL. The cache is per page session, keyed by the
// versioned icon URL, so the wheel and the shortcut panel share one request.

import { apiFetch } from './http';

const cache = new Map<string, Promise<string | null>>();

/** Authenticated object URL for an icon, or null when it cannot be loaded. */
export function iconObjectUrl(url: string | null): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  const existing = cache.get(url);
  if (existing) return existing;
  const job = apiFetch(url)
    .then(async (res) => {
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    })
    .catch(() => null)
    .then((value) => {
      // Do not cache a failure: pairing or a host coming back online should be
      // able to retry the same versioned URL.
      if (!value) cache.delete(url);
      return value;
    });
  cache.set(url, job);
  return job;
}
