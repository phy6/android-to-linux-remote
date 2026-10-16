// Version checking for both halves of TailDeck:
//   * the web app itself (this bundle, served from Pages or the laptop), and
//   * the daemon running on the laptop.
//
// The release channel is the published Pages site; it carries version.json,
// written at build time. The phone compares that against its own build stamp and
// against the daemon's /api/version to decide what, if anything, is out of date.

import { apiBase } from './scriptsClient';

export const RELEASE_URL = 'https://phy6.github.io/android-to-linux-remote';
export const APP_VERSION = __APP_VERSION__;
export const APP_SHA = __BUILD_SHA__;
export const BUILD_TIME = __BUILD_TIME__;

export interface ReleaseManifest {
  app?: string;
  appSha?: string;
  daemon?: string;
  builtAt?: string;
  files?: Record<string, string>;
}

export interface LaptopVersion {
  daemon?: string;
  backend?: string;
  release?: string;
  webroot?: string;
  managed?: boolean;
  latest?: string | null;
  latestApp?: string | null;
  updateAvailable?: boolean;
}

export interface UpdateCheck {
  app: {
    current: string;
    sha: string;
    latest?: string;
    latestSha?: string;
    updateAvailable: boolean;
  };
  laptop: {
    current?: string;
    latest?: string | null;
    updateAvailable: boolean;
    reachable: boolean;
    managed?: boolean;
  };
  checkedAt: number;
}

export function shortSha(value?: string | null): string {
  return (value || '').slice(0, 7);
}

export function isDevBuild(): boolean {
  return !APP_SHA || APP_SHA === 'local';
}

/** Fetch the published manifest, trying the channel then our own origin. */
export async function fetchRelease(force = false): Promise<ReleaseManifest | null> {
  const bust = force ? `?t=${Date.now()}` : '';
  const urls = [
    `${RELEASE_URL}/version.json${bust}`,
    `${import.meta.env.BASE_URL}version.json${bust}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: force ? 'no-store' : 'default' });
      if (res.ok) return (await res.json()) as ReleaseManifest;
    } catch {
      // Try the next source.
    }
  }
  return null;
}

export async function fetchLaptopVersion(host: string): Promise<LaptopVersion | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/version`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as LaptopVersion;
  } catch {
    return null;
  }
}

export interface UpdateResult {
  ok: boolean;
  error?: string;
  from?: string;
  to?: string;
  app?: string;
  steps?: string[];
  restart?: string | null;
  [key: string]: unknown;
}

export async function updateLaptop(
  host: string,
  opts: { requestId?: string; confirm?: boolean; dryRun?: boolean },
): Promise<UpdateResult> {
  const base = apiBase(host);
  if (!base) return { ok: false, error: 'not connected to a laptop' };
  try {
    const res = await fetch(`${base}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return (await res.json()) as UpdateResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'update failed' };
  }
}

/** Compare our own build and the daemon against the published manifest. */
export async function checkForUpdate(host?: string): Promise<UpdateCheck> {
  const [release, laptop] = await Promise.all([
    fetchRelease(true),
    host ? fetchLaptopVersion(host) : Promise.resolve(null as LaptopVersion | null),
  ]);

  const latestSha = release?.appSha;
  const appUpdateAvailable = !!latestSha && !isDevBuild() && latestSha !== APP_SHA;

  return {
    app: {
      current: APP_VERSION,
      sha: APP_SHA,
      latest: release?.app,
      latestSha,
      updateAvailable: appUpdateAvailable,
    },
    laptop: {
      current: laptop?.daemon,
      latest: laptop?.latest ?? release?.daemon ?? null,
      updateAvailable: !!laptop?.updateAvailable,
      reachable: !!laptop,
      managed: laptop?.managed,
    },
    checkedAt: Date.now(),
  };
}
