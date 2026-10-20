// Spatial multi-host layout.
//
// Two different things used to share one model: the laptop roster and the desk.
// They are now separate. `HostSpatialConfig` is only metadata (name, short id,
// online/latency). The desk is a `ScreenLayout`: every physical output from
// every saved laptop is one rectangle with logical x/y/width/height. Screens
// from the same laptop are independent nodes, so an external screen can sit
// between two screens that belong to another machine.

import type { SavedLaptop } from './savedLaptops';
import type { Monitor } from './displaysClient';
import { parseHostTarget } from './netTarget';

// Re-exported so consumers keep importing monitor geometry from here.
export type { Monitor };

export type DisplayRotation = 0 | 90 | 180 | 270;
export type PassOffDirection = 'left' | 'right' | 'top' | 'bottom';
export const PASS_OFF_DIRECTIONS: PassOffDirection[] = ['left', 'right', 'top', 'bottom'];

/** Laptop metadata, keyed by saved address. Geometry lives in `ScreenLayout`. */
export interface HostSpatialConfig {
  host: string;
  name: string;
  shortId: string;
  /** True once the user has chosen the label, so auto-derivation leaves it alone. */
  shortIdCustom?: boolean;
  isOnline?: boolean;
  latencyMs?: number;
  lastChecked?: number;
  /** A warm background websocket is authenticated right now, not just an HTTP probe. */
  linked?: boolean;
}

export const SPATIAL_STORAGE_KEY = 'taildeck_spatial_layout_v1';
/** The independent screen map. Kept separate from the host metadata key so a
 * new desk model does not have to migrate the old ring-shaped config blob. */
export const SCREEN_LAYOUT_STORAGE_KEY = 'taildeck_screen_layout_v1';

/** One physical output placed in the logical desk. Coordinates are logical px,
 * matching the monitor's own resolution, so edges can be snapped together. */
export interface ScreenPlacement {
  host: string;
  output: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: DisplayRotation;
}

export type ScreenLayout = Record<string, ScreenPlacement>;

export interface ScreenHost {
  host: string;
  monitors: Monitor[];
  /** The laptop currently driving the pointer. */
  active?: boolean;
}

export interface ScreenPointer {
  output: string | null;
  x: number;
  y: number;
}

export function deriveShortId(name: string, host: string): string {
  const source = name || host;
  const cleanName = source.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleanName) return 'PC';
  // An IP host with no name reduces to digits only; never label a laptop with a
  // bare number (that rendered the primary as "10" from "10.117.111.121").
  if (!/[a-zA-Z]/.test(cleanName)) return 'PC';
  // Prefer the first all-caps word, which is the vendor tag in hostnames like
  // "martin-HP-ProBook-6360b" or "HP-ProBook" -> "HP". Avoids the scattered-caps
  // "HPB"/"HPP" the old heuristics produced.
  const capsWord = source.match(/\b[A-Z]{2,4}\b/)?.[0];
  if (capsWord) return capsWord.slice(0, 3);
  // No separators: accept a leading capital run, e.g. "HPProBook" -> "HP".
  const leading = cleanName.match(/^[A-Z]{2,}/)?.[0];
  if (leading) return leading.slice(0, 3);
  if (cleanName.length <= 3) return cleanName.toUpperCase();
  const uppercaseMatches = cleanName.match(/[A-Z]/g);
  if (uppercaseMatches && uppercaseMatches.length >= 2) {
    return uppercaseMatches.slice(0, 3).join('');
  }
  return cleanName.slice(0, 2).toUpperCase();
}

export interface DesktopBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Bounding box of the whole virtual desktop, or null with no monitors. */
export function desktopBounds(monitors: Monitor[]): DesktopBounds | null {
  if (monitors.length === 0) return null;
  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function screenBounds(screens: ScreenPlacement[]): DesktopBounds | null {
  if (screens.length === 0) return null;
  const minX = Math.min(...screens.map((s) => s.x));
  const minY = Math.min(...screens.map((s) => s.y));
  const maxX = Math.max(...screens.map((s) => s.x + s.width));
  const maxY = Math.max(...screens.map((s) => s.y + s.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function screenKey(host: string, output: string): string {
  return `${host}::${output}`;
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

export function loadScreenLayout(): ScreenLayout {
  try {
    const raw = localStorage.getItem(SCREEN_LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveScreenLayout(layout: ScreenLayout): void {
  try {
    localStorage.setItem(SCREEN_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage full/unavailable: layout is a convenience, never required state.
  }
}

/** Build a metadata config for a laptop that has never been seen. */
export function createHostConfig(laptop: SavedLaptop): HostSpatialConfig {
  return {
    host: laptop.host,
    name: laptop.name,
    shortId: deriveShortId(laptop.name, laptop.host),
  };
}

/**
 * Merge `savedLaptops` into the host metadata map. Geometry is handled by
 * `withScreenLayout`; this only keeps names and labels in step.
 */
export function withSavedLaptops(
  configs: Record<string, HostSpatialConfig>,
  savedLaptops: SavedLaptop[],
): { next: Record<string, HostSpatialConfig>; changed: boolean } {
  let changed = false;
  const next = { ...configs };

  // Configs are keyed by address, but a laptop is an identity. When it
  // reconnects through a different route, `rememberLaptop` moves `host` and
  // keeps the old address as an alternate. Migrate the metadata to the new key
  // instead of leaving a stale one behind.
  const hostnameOf = (address: string): string | null =>
    parseHostTarget(address)?.host ?? null;
  const savedHosts = new Set(savedLaptops.map((laptop) => laptop.host));
  for (const key of Object.keys(next)) {
    if (savedHosts.has(key)) continue;
    const keyHost = hostnameOf(key);
    const match = keyHost
      ? savedLaptops.find((laptop) =>
          [laptop.host, laptop.tailnet ?? '', laptop.lastGood?.host ?? '', ...(laptop.alt ?? [])].some(
            (address) => hostnameOf(address) === keyHost,
          ),
        )
      : undefined;
    if (match && !next[match.host]) {
      next[match.host] = { ...next[key], host: match.host };
    }
    delete next[key];
    changed = true;
  }

  savedLaptops.forEach((laptop) => {
    if (!next[laptop.host]) {
      next[laptop.host] = createHostConfig(laptop);
      changed = true;
      return;
    }
    // Keep the id in step with the name unless the user picked it themselves.
    // This also repairs ids from earlier builds (e.g. the primary showing "HPP"
    // for "HP-ProBook", or "10" for an unnamed IP host).
    const cfg = next[laptop.host];
    if (!cfg.shortIdCustom) {
      // Prefer the fresh name, but fall back to the stored one if the laptop
      // arrived without a label (e.g. a shell-roster entry with just an IP).
      const sourceName = /[a-zA-Z]/.test(laptop.name || '') ? laptop.name : cfg.name;
      const fresh = deriveShortId(sourceName, laptop.host);
      if (cfg.shortId !== fresh) {
        next[laptop.host] = { ...cfg, shortId: fresh };
        changed = true;
      }
    }
  });

  return { next, changed };
}

/** Horizontal gap between two host blocks when a new block is auto-placed. Zero
 * means a fresh desk is immediately usable: the rightmost screen of one laptop
 * touches the leftmost screen of the next, so a folder drag can cross without a
 * manual arrange first. The user can still drag a gap between them. */
const HOST_GAP = 0;

function monitorSort(a: Monitor, b: Monitor): number {
  return a.x - b.x || a.y - b.y;
}

/** Candidate position for a host's monitor block when none of its screens are
 * on the desk yet. Active is added to the left of anything already there; a
 * neighbour to the right. This keeps the active laptop at the origin on first
 * run and lets a late-arriving active desk extend the world instead of landing
 * on top of a neighbour. */
function blockAnchor(
  screens: ScreenPlacement[],
  host: ScreenHost,
  hostBounds: DesktopBounds,
): { x: number; y: number } {
  const all = screenBounds(screens);
  if (!all) return { x: 0, y: 0 };
  if (host.active) {
    return { x: all.minX - hostBounds.width - HOST_GAP, y: all.minY };
  }
  return { x: all.maxX + HOST_GAP, y: all.minY };
}

/**
 * Ensure every reported monitor has exactly one placement, preserving cells the
 * user has already moved. Empty monitor lists mean "unknown" (offline or a
 * Wayland host that cannot answer `/api/displays`), so existing placements are
 * kept rather than deleted. A non-empty list is authoritative; outputs that are
 * gone are removed.
 */
export function withScreenLayout(
  layout: ScreenLayout,
  hosts: ScreenHost[],
  validHosts: Set<string>,
  savedLaptops: SavedLaptop[] = [],
): { next: ScreenLayout; changed: boolean } {
  let changed = false;
  const next: ScreenLayout = {};

  // A saved laptop can reconnect through a different address (hotspot IP,
  // tailnet name, last-good route). Host metadata already migrates; geometry
  // must follow it or the user's desk resets on every route change. Match on
  // hostname the same way `withSavedLaptops` does, then rewrite the key.
  const hostnameOf = (address: string): string | null =>
    parseHostTarget(address)?.host ?? null;
  const remapHost = (host: string): string | null => {
    if (validHosts.has(host)) return host;
    const hostname = hostnameOf(host);
    if (!hostname) return null;
    const match = savedLaptops.find((laptop) =>
      [laptop.host, laptop.tailnet ?? '', laptop.lastGood?.host ?? '', ...(laptop.alt ?? [])].some(
        (address) => hostnameOf(address) === hostname,
      ),
    );
    return match && validHosts.has(match.host) ? match.host : null;
  };

  for (const [key, placement] of Object.entries(layout)) {
    const host = remapHost(placement.host);
    if (!host) {
      changed = true;
      continue;
    }
    const nextKey = screenKey(host, placement.output);
    if (host !== placement.host) {
      // If the current address already has this output, keep that placement and
      // discard the stale route key rather than letting iteration order decide.
      if (!next[nextKey]) next[nextKey] = { ...placement, host };
      changed = true;
    } else {
      next[key] = placement;
    }
  }

  for (const host of hosts) {
    if (host.monitors.length === 0) continue;

    const outputs = new Set(host.monitors.map((m) => m.output));
    for (const placement of Object.values(next)) {
      if (placement.host !== host.host) continue;
      if (!outputs.has(placement.output)) {
        delete next[screenKey(placement.host, placement.output)];
        changed = true;
      }
    }

    const existing = Object.values(next).filter((p) => p.host === host.host);
    const hostMonitors = [...host.monitors].sort(monitorSort);
    const hostBounds = desktopBounds(hostMonitors);
    if (!hostBounds) continue;

    let anchorX: number | null = null;
    let anchorY: number | null = null;

    // A host that already has screens keeps their local offsets: place a newly
    // hotplugged output relative to a known sibling rather than at the edge of
    // the world.
    const base = existing.find((p) => hostMonitors.some((m) => m.output === p.output));
    if (base) {
      const baseMonitor = hostMonitors.find((m) => m.output === base.output);
      if (baseMonitor) {
        anchorX = base.x - baseMonitor.x;
        anchorY = base.y - baseMonitor.y;
      }
    }

    if (anchorX === null || anchorY === null) {
      const anchor = blockAnchor(Object.values(next), host, hostBounds);
      anchorX = anchor.x;
      anchorY = anchor.y;
    }

    for (const monitor of hostMonitors) {
      const key = screenKey(host.host, monitor.output);
      const current = next[key];
      const x =
        current && base
          ? current.x
          : anchorX + (monitor.x - hostBounds.minX);
      const y =
        current && base
          ? current.y
          : anchorY + (monitor.y - hostBounds.minY);
      if (!current) {
        next[key] = {
          host: host.host,
          output: monitor.output,
          x,
          y,
          width: monitor.width,
          height: monitor.height,
          rotation: (monitor.rotation ?? 0) as DisplayRotation,
        };
        changed = true;
        continue;
      }
      // Dimensions can change on a mode switch; the user's chosen desk position
      // is intentionally kept.
      if (
        current.width !== monitor.width ||
        current.height !== monitor.height ||
        (current.rotation ?? 0) !== (monitor.rotation ?? 0)
      ) {
        next[key] = {
          ...current,
          width: monitor.width,
          height: monitor.height,
          rotation: (monitor.rotation ?? 0) as DisplayRotation,
        };
        changed = true;
      }
    }
  }

  return { next, changed };
}

function crossAxisOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

/**
 * The screen on the other side of a shared edge. `point` is the pointer position
 * mapped into the logical desk; when supplied it disambiguates two stacked
 * screens that both touch the same edge.
 */
export function screenNeighbor(
  layout: ScreenLayout,
  source: ScreenPlacement,
  direction: PassOffDirection,
  point?: { x: number; y: number },
  tolerance = 2,
): ScreenPlacement | null {
  const edge = (p: ScreenPlacement): number => {
    switch (direction) {
      case 'right':
        return p.x;
      case 'left':
        return p.x + p.width;
      case 'bottom':
        return p.y;
      case 'top':
        return p.y + p.height;
    }
  };
  const sourceEdge = ((): number => {
    switch (direction) {
      case 'right':
        return source.x + source.width;
      case 'left':
        return source.x;
      case 'bottom':
        return source.y + source.height;
      case 'top':
        return source.y;
    }
  })();

  const candidates = Object.values(layout).filter((p) => {
    if (p.host === source.host && p.output === source.output) return false;
    if (Math.abs(edge(p) - sourceEdge) > tolerance) return false;
    if (direction === 'left' || direction === 'right') {
      return crossAxisOverlap(source.y, source.y + source.height, p.y, p.y + p.height) > 0;
    }
    return crossAxisOverlap(source.x, source.x + source.width, p.x, p.x + p.width) > 0;
  });

  if (candidates.length === 0) return null;

  if (point) {
    const containing = candidates.find((p) => {
      if (direction === 'left' || direction === 'right') {
        return point.y >= p.y && point.y < p.y + p.height;
      }
      return point.x >= p.x && point.x < p.x + p.width;
    });
    if (containing) return containing;
  }

  return candidates.sort((a, b) => {
    const overlapA =
      direction === 'left' || direction === 'right'
        ? crossAxisOverlap(source.y, source.y + source.height, a.y, a.y + a.height)
        : crossAxisOverlap(source.x, source.x + source.width, a.x, a.x + a.width);
    const overlapB =
      direction === 'left' || direction === 'right'
        ? crossAxisOverlap(source.y, source.y + source.height, b.y, b.y + b.height)
        : crossAxisOverlap(source.x, source.x + source.width, b.x, b.x + b.width);
    return overlapB - overlapA;
  })[0];
}

/** Map the daemon's pointer coordinates onto the logical desk. The daemon
 * reports which output the pointer is on, plus the virtual-desktop coordinates;
 * the output's own rectangle gives the relative position inside that screen. */
export function pointerOnDesk(
  layout: ScreenLayout,
  activeHost: string,
  pointer: ScreenPointer | null | undefined,
  monitors: Monitor[],
): { screen: ScreenPlacement; point: { x: number; y: number } } | null {
  if (!pointer?.output) return null;
  const screen = Object.values(layout).find(
    (p) => p.host === activeHost && p.output === pointer.output,
  );
  if (!screen) return null;
  const monitor = monitors.find((m) => m.output === pointer.output);
  if (!monitor || monitor.width <= 0 || monitor.height <= 0) {
    return { screen, point: { x: screen.x + screen.width / 2, y: screen.y + screen.height / 2 } };
  }
  const relX = (pointer.x - monitor.x) / monitor.width;
  const relY = (pointer.y - monitor.y) / monitor.height;
  return {
    screen,
    point: {
      x: screen.x + Math.min(1, Math.max(0, relX)) * screen.width,
      y: screen.y + Math.min(1, Math.max(0, relY)) * screen.height,
    },
  };
}

/**
 * Resolve a trackpad edge push to the neighbouring physical screen. When the
 * pointer is known, only the screen under it is considered; crossing the seam
 * between two screens of the *same* laptop returns null so the local compositor
 * can move the pointer there without TailDeck switching hosts.
 */
export function resolvePassOff(
  layout: ScreenLayout,
  activeHost: string,
  direction: PassOffDirection,
  pointer: ScreenPointer | null | undefined,
  monitors: Monitor[],
): ScreenPlacement | null {
  const anchor = pointerOnDesk(layout, activeHost, pointer, monitors);
  if (anchor) {
    const neighbor = screenNeighbor(layout, anchor.screen, direction, anchor.point);
    return neighbor && neighbor.host !== activeHost ? neighbor : null;
  }

  // No pointer (Wayland, xdotool unavailable) or an output not yet in the map:
  // keep the old heuristic, but only for screens that actually have a remote
  // neighbour on that side.
  const activeScreens = Object.values(layout).filter((p) => p.host === activeHost);
  for (const screen of activeScreens) {
    const neighbor = screenNeighbor(layout, screen, direction);
    if (neighbor && neighbor.host !== activeHost) return neighbor;
  }
  return null;
}

/** Directions in which at least one of the active laptop's screens touches a
 * screen owned by another laptop. The trackpad needs this set before a gesture. */
export function passOffDirections(
  layout: ScreenLayout,
  activeHost: string,
): PassOffDirection[] {
  const activeScreens = Object.values(layout).filter((p) => p.host === activeHost);
  const directions = new Set<PassOffDirection>();
  for (const screen of activeScreens) {
    for (const direction of PASS_OFF_DIRECTIONS) {
      const neighbor = screenNeighbor(layout, screen, direction);
      if (neighbor && neighbor.host !== activeHost) directions.add(direction);
    }
  }
  return PASS_OFF_DIRECTIONS.filter((d) => directions.has(d));
}

/**
 * Lay every known screen out in one touching row, grouped by laptop and ordered
 * by each screen's current left edge. This works from persisted geometry alone,
 * so Auto arrange is still useful on Wayland or when a neighbour is offline (the
 * monitor list would otherwise be empty and a clear-and-rebuild would lose the
 * tiles). Hosts are ordered active first, then in saved order.
 */
export function arrangeScreens(layout: ScreenLayout, hostOrder: string[]): ScreenLayout {
  const groups = new Map<string, ScreenPlacement[]>();
  for (const screen of Object.values(layout)) {
    const list = groups.get(screen.host);
    if (list) list.push(screen);
    else groups.set(screen.host, [screen]);
  }
  const orderedHosts = [
    ...hostOrder.filter((host) => groups.has(host)),
    ...[...groups.keys()].filter((host) => !hostOrder.includes(host)),
  ];

  const next: ScreenLayout = {};
  let cursorX = 0;
  for (const host of orderedHosts) {
    const screens = [...(groups.get(host) ?? [])].sort(
      (a, b) => a.x - b.x || a.y - b.y,
    );
    for (const screen of screens) {
      next[screenKey(screen.host, screen.output)] = {
        ...screen,
        x: cursorX,
        y: 0,
      };
      cursorX += screen.width;
    }
  }
  return next;
}

/** True when two logical screens overlap; overlapping edges make pass-off
 * ambiguous, so the editor warns instead of silently picking one. */
export function screensOverlap(screens: ScreenPlacement[]): boolean {
  return screens.some((a, i) =>
    screens.some(
      (b, j) =>
        j > i &&
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height,
    ),
  );
}
