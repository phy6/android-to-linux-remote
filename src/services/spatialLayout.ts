// Spatial multi-host layout: where each saved laptop physically sits around the
// primary screen, plus its display rotation and a short label for compact icons.
//
// This module is pure (no React) so it can be unit-tested and reused. The
// reactive wrapper lives in `src/hooks/useSpatialLayout.ts`.

import { SavedLaptop } from './savedLaptops';

export type SpatialPosition = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DisplayRotation = 0 | 90 | 180 | 270;

export interface HostSpatialConfig {
  host: string;
  name: string;
  shortId: string;
  position: SpatialPosition;
  rotation: DisplayRotation;
  isOnline?: boolean;
  latencyMs?: number;
  lastChecked?: number;
}

export const SPATIAL_STORAGE_KEY = 'taildeck_spatial_layout_v1';

/** The four slots that can hold a secondary host, in ring order. */
export const RING_POSITIONS: SpatialPosition[] = ['right', 'top', 'left', 'bottom'];

export function deriveShortId(name: string, host: string): string {
  const cleanName = (name || host).replace(/[^a-zA-Z0-9]/g, '');
  if (!cleanName) return 'PC';
  if (cleanName.length <= 3) return cleanName.toUpperCase();
  const uppercaseMatches = cleanName.match(/[A-Z]/g);
  if (uppercaseMatches && uppercaseMatches.length >= 2) {
    return uppercaseMatches.slice(0, 3).join('');
  }
  return cleanName.slice(0, 2).toUpperCase();
}

/** Build a default config for a laptop that has never been placed. */
export function createHostConfig(laptop: SavedLaptop, activeHost: string, index = 0): HostSpatialConfig {
  const isActive = laptop.host === activeHost;
  return {
    host: laptop.host,
    name: laptop.name,
    shortId: deriveShortId(laptop.name, laptop.host),
    position: isActive ? 'center' : RING_POSITIONS[index % RING_POSITIONS.length],
    rotation: 0,
  };
}

export function loadSpatialConfigs(): Record<string, HostSpatialConfig> {
  try {
    const raw = localStorage.getItem(SPATIAL_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveSpatialConfigs(configs: Record<string, HostSpatialConfig>): void {
  try {
    localStorage.setItem(SPATIAL_STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // Storage full/unavailable: layout is a convenience, never required state.
  }
}

/** Merge `savedLaptops` into `configs`, filling in defaults for any new host. */
export function withSavedLaptops(
  configs: Record<string, HostSpatialConfig>,
  savedLaptops: SavedLaptop[],
  activeHost: string,
): { next: Record<string, HostSpatialConfig>; changed: boolean } {
  let changed = false;
  const next = { ...configs };
  savedLaptops.forEach((laptop, idx) => {
    if (!next[laptop.host]) {
      next[laptop.host] = createHostConfig(laptop, activeHost, idx);
      changed = true;
    }
  });
  return { next, changed };
}
