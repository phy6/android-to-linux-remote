// Monitor geometry and pointer placement for one laptop.
//
// `xrandr` gives every output a size *and* an offset into the virtual desktop.
// The offsets are the whole point: without them the phone cannot tell a monitor
// edge that faces another laptop from the seam between two monitors of the same
// laptop, and would hand control off in the middle of a two-screen desk.

import { apiBase, apiFetch, isUnauthorized } from './http';

export interface Monitor {
  output: string;
  width: number;
  height: number;
  /** Offset of the monitor's top-left corner in the virtual desktop. */
  x: number;
  y: number;
  /** Clockwise rotation in degrees (0/90/180/270). Geometry is post-rotation. */
  rotation?: number;
}

export interface PointerLocation {
  x: number;
  y: number;
  /** Output the pointer is on, or null when it is on none (e.g. mid-move). */
  output: string | null;
}

interface RawDisplay {
  output?: unknown;
  connected?: unknown;
  width?: unknown;
  height?: unknown;
  x?: unknown;
  y?: unknown;
  rotation?: unknown;
}

function cleanMonitor(raw: RawDisplay): Monitor | null {
  if (raw.connected !== true || typeof raw.output !== 'string') return null;
  const { width, height, x, y } = raw;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const rotation =
    typeof raw.rotation === 'number' && [0, 90, 180, 270].includes(raw.rotation)
      ? raw.rotation
      : undefined;
  return { output: raw.output, width, height, x, y, rotation };
}

function parseMonitors(value: unknown): Monitor[] {
  if (!Array.isArray(value)) return [];
  return (value as RawDisplay[])
    .map(cleanMonitor)
    .filter((m): m is Monitor => m !== null);
}

/** Connected monitors that report a geometry. Empty when unsupported. */
export async function fetchMonitors(host: string): Promise<Monitor[]> {
  const base = apiBase(host);
  if (!base) return [];
  try {
    const res = await apiFetch(`${base}/api/displays`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.ok) return [];
    return parseMonitors(data.displays);
  } catch {
    return [];
  }
}

/** One output's new place/orientation. x/y are post-rotation desktop offsets. */
export interface DisplayLayoutChange {
  output: string;
  x?: number;
  y?: number;
  rotation?: 0 | 90 | 180 | 270;
  mode?: string;
  reflect?: 'none' | 'x' | 'y' | 'xy';
  primary?: boolean;
}

export interface DisplayLayoutResult {
  ok: boolean;
  detail: string;
  /** Geometry as the daemon read it back after the change. */
  displays: Monitor[];
}

/**
 * Apply a whole layout in one `xrandr` call. A secure page carries the paired
 * device token through `apiFetch`; a neighbour's desktop cannot be edited from
 * another host's origin, so this is only used for the connected laptop.
 */
export async function applyDisplayLayout(
  host: string,
  changes: DisplayLayoutChange[],
): Promise<DisplayLayoutResult> {
  const base = apiBase(host);
  if (!base) return { ok: false, detail: 'No usable address for this laptop', displays: [] };
  try {
    const res = await apiFetch(`${base}/api/displays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputs: changes }),
    });
    let data: { ok?: unknown; detail?: unknown; displays?: unknown } | null = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (isUnauthorized(res)) {
      return { ok: false, detail: 'This phone is not paired with the laptop', displays: [] };
    }
    return {
      ok: res.ok && data?.ok === true,
      detail:
        typeof data?.detail === 'string'
          ? data.detail
          : res.ok
            ? 'ok'
            : `xrandr failed (${res.status})`,
      displays: parseMonitors(data?.displays),
    };
  } catch {
    return { ok: false, detail: 'Could not reach the laptop', displays: [] };
  }
}

/**
 * Where the pointer is and which monitor holds it. Null when the daemon cannot
 * answer (Wayland, or no xdotool), in which case pass-off stays heuristic.
 */
export async function fetchPointer(host: string): Promise<PointerLocation | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await apiFetch(`${base}/api/pointer`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data?.pointer as { x?: unknown; y?: unknown; output?: unknown } | undefined;
    if (!data?.ok || !p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: p.x, y: p.y, output: typeof p.output === 'string' ? p.output : null };
  } catch {
    return null;
  }
}
