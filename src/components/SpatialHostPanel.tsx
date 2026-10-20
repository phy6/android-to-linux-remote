import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Copy,
  Edit3,
  LayoutGrid,
  Monitor as MonitorIcon,
  Move,
  X,
  Zap,
} from 'lucide-react';
import { ConnectionStatus } from '../types';
import { SavedLaptop } from '../services/savedLaptops';
import { savedIdentityFor } from '../services/hostRoutes';
import {
  HostSpatialConfig,
  Monitor,
  ScreenLayout,
  ScreenPlacement,
  deriveShortId,
  screenBounds,
  screenKey,
  screensOverlap,
} from '../services/spatialLayout';

export interface SpatialHostPanelProps {
  connectionStatus: ConnectionStatus;
  savedLaptops: SavedLaptop[];
  spatialConfigs: Record<string, HostSpatialConfig>;
  screenLayout: ScreenLayout;
  /** Active host's monitors, for the pointer mapping and live labels. */
  monitors: Monitor[];
  /** Every other saved laptop's monitors; empty means offline/unknown. */
  monitorsByHost: Record<string, Monitor[]>;
  onUpdateShortId: (host: string, shortId: string) => void;
  onUpdateScreenPosition: (host: string, output: string, x: number, y: number) => void;
  onAutoArrange: () => void;
  onSelectHost: (host: string) => void;
  onOpenDisplays?: () => void;
}

interface World {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface DragState {
  key: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  /** Logical pixels per CSS pixel, per axis. */
  scaleX: number;
  scaleY: number;
}

interface HostAccent {
  border: string;
  ring: string;
  bg: string;
  text: string;
  dot: string;
}

/** Stable per-host tint. The active laptop is always first, so it stays sky. */
const HOST_ACCENTS: HostAccent[] = [
  {
    border: 'border-sky-400',
    ring: 'ring-sky-300',
    bg: 'bg-sky-500/15',
    text: 'text-sky-200',
    dot: 'bg-sky-300',
  },
  {
    border: 'border-emerald-400',
    ring: 'ring-emerald-300',
    bg: 'bg-emerald-500/15',
    text: 'text-emerald-200',
    dot: 'bg-emerald-300',
  },
  {
    border: 'border-amber-400',
    ring: 'ring-amber-300',
    bg: 'bg-amber-500/15',
    text: 'text-amber-200',
    dot: 'bg-amber-300',
  },
  {
    border: 'border-violet-400',
    ring: 'ring-violet-300',
    bg: 'bg-violet-500/15',
    text: 'text-violet-200',
    dot: 'bg-violet-300',
  },
  {
    border: 'border-rose-400',
    ring: 'ring-rose-300',
    bg: 'bg-rose-500/15',
    text: 'text-rose-200',
    dot: 'bg-rose-300',
  },
  {
    border: 'border-cyan-400',
    ring: 'ring-cyan-300',
    bg: 'bg-cyan-500/15',
    text: 'text-cyan-200',
    dot: 'bg-cyan-300',
  },
];

const SNAP = 10;
const SNAP_THRESHOLD = 34;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A stable amount of empty desk around the current screens. Fixed while a screen
 * is being dragged so the logical-to-CSS scale does not move under the finger;
 * recomputed after the drop so the world grows when a screen is pushed outwards.
 */
function worldFor(screens: ScreenPlacement[]): World {
  const bounds = screenBounds(screens);
  if (!bounds) return { minX: 0, minY: 0, width: 1920, height: 1080 };
  const padX = Math.max(180, Math.round(bounds.width * 0.14));
  const padY = Math.max(110, Math.round(bounds.height * 0.2));
  return {
    minX: bounds.minX - padX,
    minY: bounds.minY - padY,
    width: bounds.width + padX * 2,
    height: bounds.height + padY * 2,
  };
}

/**
 * Pull one edge flush with another screen when it lands close. This is the
 * "stick them together" behaviour from the single-laptop xrandr editor: a small
 * gap becomes dead desktop and a folder drag cannot cross it.
 */
function snapAxis(
  value: number,
  size: number,
  others: ScreenPlacement[],
  axis: 'x' | 'y',
  threshold = SNAP_THRESHOLD,
): number {
  const starts = others.map((screen) => screen[axis]);
  const ends = others.map((screen) => screen[axis] + (axis === 'x' ? screen.width : screen.height));
  const candidates = [
    ...starts,
    ...ends,
    ...starts.map((start) => start - size),
    ...ends.map((end) => end - size),
  ];
  let best = value;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The independent screen desk.
 *
 * Every monitor is a rectangle in one logical world. Geometry is its own
 * persisted map keyed by `host::output`, so a laptop's external screen can be
 * dragged between two screens owned by a different laptop. Dragging is direct
 * (no long-press): the sheet has one job, and every tile is a drag handle.
 */
export const SpatialHostPanel: React.FC<SpatialHostPanelProps> = ({
  connectionStatus,
  savedLaptops,
  spatialConfigs,
  screenLayout,
  monitors,
  monitorsByHost,
  onUpdateShortId,
  onUpdateScreenPosition,
  onAutoArrange,
  onSelectHost,
  onOpenDisplays,
}) => {
  const [layout, setLayout] = useState<ScreenPlacement[]>(() =>
    Object.values(screenLayout),
  );
  const [world, setWorld] = useState<World>(() =>
    worldFor(Object.values(screenLayout)),
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editingShortIdHost, setEditingShortIdHost] = useState<string | null>(null);
  const [shortIdInput, setShortIdInput] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);

  const activeHost = savedIdentityFor(
    connectionStatus.hostAddress,
    savedLaptops,
    connectionStatus.hostOsInfo,
  );

  // The hook is the source of truth. The local copy only exists so a drag can
  // move smoothly without writing localStorage on every pointermove.
  useEffect(() => {
    if (drag) return;
    const next = Object.values(screenLayout);
    setLayout(next);
    setWorld(worldFor(next));
  }, [screenLayout, drag]);

  const hostOrder = useMemo(() => {
    const order: string[] = [];
    if (activeHost) order.push(activeHost);
    for (const laptop of savedLaptops) {
      if (!order.includes(laptop.host)) order.push(laptop.host);
    }
    for (const screen of layout) {
      if (!order.includes(screen.host)) order.push(screen.host);
    }
    return order;
  }, [activeHost, savedLaptops, layout]);

  const accentFor = (host: string): HostAccent => {
    const index = Math.max(0, hostOrder.indexOf(host));
    return HOST_ACCENTS[index % HOST_ACCENTS.length];
  };

  const nameFor = (host: string): string =>
    spatialConfigs[host]?.name ||
    savedLaptops.find((laptop) => laptop.host === host)?.name ||
    host;

  const shortIdFor = (host: string): string =>
    spatialConfigs[host]?.shortId || deriveShortId(nameFor(host), host);

  const screensForHost = (host: string): number =>
    layout.filter((screen) => screen.host === host).length;

  const selected = selectedKey ? layout.find((s) => screenKey(s.host, s.output) === selectedKey) : undefined;
  const selectedCfg = selected ? spatialConfigs[selected.host] : undefined;
  const selectedName = selected ? nameFor(selected.host) : '';
  const selectedIsActive = !!selected && selected.host === activeHost;
  const selectedMonitors =
    selected && selected.host === activeHost
      ? monitors
      : selected
        ? monitorsByHost[selected.host] ?? []
        : [];
  const selectedLiveMonitor = selected
    ? selectedMonitors.find((m) => m.output === selected.output)
    : undefined;

  const overlap = useMemo(() => screensOverlap(layout), [layout]);
  const totalHosts = hostOrder.filter((host) => screensForHost(host) > 0).length;

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, screen: ScreenPlacement) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    const scaleX = rect && rect.width > 0 ? world.width / rect.width : 1;
    const scaleY = rect && rect.height > 0 ? world.height / rect.height : 1;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail after a cancelled touch; the tile still tracks
      // while the finger stays over it.
    }
    setSelectedKey(screenKey(screen.host, screen.output));
    setDrag({
      key: screenKey(screen.host, screen.output),
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: screen.x,
      startY: screen.y,
      scaleX,
      scaleY,
    });
  };

  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - drag.startClientX) * drag.scaleX;
    const dy = (event.clientY - drag.startClientY) * drag.scaleY;
    setLayout((prev) =>
      prev.map((screen) => {
        if (screenKey(screen.host, screen.output) !== drag.key) return screen;
        const nextX = clamp(
          Math.round((drag.startX + dx) / SNAP) * SNAP,
          world.minX,
          world.minX + world.width - screen.width,
        );
        const nextY = clamp(
          Math.round((drag.startY + dy) / SNAP) * SNAP,
          world.minY,
          world.minY + world.height - screen.height,
        );
        if (nextX === screen.x && nextY === screen.y) return screen;
        return { ...screen, x: nextX, y: nextY };
      }),
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const key = drag.key;
    const screen = layout.find((s) => screenKey(s.host, s.output) === key);
    if (!screen) {
      setDrag(null);
      return;
    }
    const others = layout.filter((s) => screenKey(s.host, s.output) !== key);
    const x = clamp(
      snapAxis(screen.x, screen.width, others, 'x'),
      world.minX,
      world.minX + world.width - screen.width,
    );
    const y = clamp(
      snapAxis(screen.y, screen.height, others, 'y'),
      world.minY,
      world.minY + world.height - screen.height,
    );
    if (x !== screen.x || y !== screen.y) {
      setLayout((prev) =>
        prev.map((s) =>
          screenKey(s.host, s.output) === key ? { ...s, x, y } : s,
        ),
      );
    }
    onUpdateScreenPosition(screen.host, screen.output, x, y);
    setDrag(null);
  };

  const handleSaveShortId = (host: string) => {
    if (shortIdInput.trim()) onUpdateShortId(host, shortIdInput.trim().toUpperCase());
    setEditingShortIdHost(null);
  };

  const pctX = (value: number) => `${((value - world.minX) / world.width) * 100}%`;
  const pctY = (value: number) => `${((value - world.minY) / world.height) * 100}%`;
  const pctW = (value: number) => `${(value / world.width) * 100}%`;
  const pctH = (value: number) => `${(value / world.height) * 100}%`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            All screens
          </span>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
            Every monitor is a separate tile, even when it belongs to the same laptop.
            Drag tiles around and let their edges snap. A folder crosses an edge only
            when two screens actually touch, and lands on the laptop that owns the
            screen on the other side.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            onAutoArrange();
            setSelectedKey(null);
          }}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-300 text-[10px] font-semibold hover:border-sky-500 hover:text-white transition"
          title="Put every known screen in a clean row"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Auto arrange
        </button>
      </div>

      {/* Host legend. The tiles are independent; the tint says who owns them. */}
      {hostOrder.some((host) => screensForHost(host) > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {hostOrder.map((host) => {
            const count = screensForHost(host);
            if (count === 0) return null;
            const accent = accentFor(host);
            const active = host === activeHost;
            return (
              <span
                key={host}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-semibold ${
                  active
                    ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                    : 'bg-slate-900 border-slate-800 text-slate-300'
                }`}
                title={nameFor(host)}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
                {shortIdFor(host)}
                <span className="text-slate-500 font-normal">
                  {count} screen{count === 1 ? '' : 's'}
                </span>
                {active && (
                  <span className="text-[8px] uppercase tracking-wider text-sky-300/80">
                    this
                  </span>
                )}
              </span>
            );
          })}
          <span className="text-[10px] text-slate-600 ml-auto">
            {layout.length} screen{layout.length === 1 ? '' : 's'} · {totalHosts} laptop
            {totalHosts === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-950/70">
        {layout.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-slate-500">
            <MonitorIcon className="w-6 h-6" />
            <span className="text-xs">No screens reported yet</span>
            <span className="text-[10px] text-center px-6">
              X11 with xrandr, or a neighbour that answers `/api/displays`, is
              required to see individual screens.
            </span>
            {onOpenDisplays && (
              <button
                type="button"
                onClick={onOpenDisplays}
                className="mt-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-[10px] font-semibold hover:border-sky-500"
              >
                Arrange this laptop's screens
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl">
            <div
              ref={canvasRef}
              className="relative select-none mx-auto"
              style={{
                height: 'clamp(210px, 31dvh, 290px)',
                aspectRatio: `${world.width} / ${world.height}`,
                minWidth: 0,
                touchAction: 'pan-x pan-y',
                backgroundImage:
                  'radial-gradient(circle at 1px 1px, rgba(51,65,85,0.55) 1px, transparent 0)',
                backgroundSize: '18px 18px',
              }}
            >
              {layout.map((screen) => {
                const key = screenKey(screen.host, screen.output);
                const accent = accentFor(screen.host);
                const active = drag?.key === key;
                const selected = selectedKey === key;
                const isActiveHost = screen.host === activeHost;
                const online = spatialConfigs[screen.host]?.isOnline;
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-label={`${screen.output} on ${nameFor(screen.host)}, ${screen.width} by ${screen.height}`}
                    onPointerDown={(event) => beginDrag(event, screen)}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        setSelectedKey(key);
                      }
                    }}
                    style={{
                      left: pctX(screen.x),
                      top: pctY(screen.y),
                      width: pctW(screen.width),
                      height: pctH(screen.height),
                      touchAction: 'none',
                      WebkitTouchCallout: 'none',
                    }}
                    className={`absolute flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border-2 p-1 text-center cursor-grab active:cursor-grabbing transition-shadow ${
                      accent.border
                    } ${
                      active
                        ? `${accent.bg} z-20 shadow-xl shadow-black/50 ring-2 ${accent.ring}`
                        : selected
                          ? `${accent.bg} z-10 ring-2 ${accent.ring}`
                          : `${accent.bg} hover:brightness-125`
                    } ${online === false ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-center gap-1 max-w-full">
                      <MonitorIcon
                        className={`w-3.5 h-3.5 shrink-0 ${accent.text}`}
                        style={{ transform: `rotate(${screen.rotation ?? 0}deg)` }}
                      />
                      <span className="text-[9px] font-bold text-white leading-none truncate">
                        {screen.output}
                      </span>
                    </div>
                    <span className={`text-[10px] font-black leading-none ${accent.text}`}>
                      {shortIdFor(screen.host)}
                    </span>
                    <span className="text-[8px] font-mono text-slate-400 leading-none truncate max-w-full">
                      {screen.width}×{screen.height}
                    </span>
                    <span className="absolute bottom-0.5 right-1 text-[7px] font-mono text-slate-500">
                      {isActiveHost ? 'this' : online === false ? 'offline' : nameFor(screen.host)}
                    </span>
                    {isActiveHost && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-300" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-start gap-1.5 px-3 py-2 border-t border-slate-800 text-[10px] text-slate-500">
          <Copy className="w-3 h-3 shrink-0 mt-0.5" />
          <span>
            Scroll sideways to reach every screen. Drag a tile by its body; edges snap
            when they get close. Overlapping tiles are ambiguous, so keep them apart.
          </span>
        </div>
      </div>

      {overlap && (
        <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
          Screens overlap. Separate them before relying on pass-off — overlapping
          edges make the target laptop ambiguous.
        </p>
      )}

      {selected && (
        <div className="rounded-2xl border border-sky-500/40 bg-slate-900/80 p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    selectedIsActive
                      ? 'bg-emerald-400'
                      : selectedCfg?.isOnline
                        ? 'bg-emerald-400'
                        : 'bg-slate-600'
                  }`}
                />
                <span className="text-xs font-semibold text-white truncate">
                  {selected.output} · {selectedName}
                </span>
              </div>
              <div className="text-[10px] text-slate-500">
                {selected.width}×{selected.height}
                {' · '}
                {selectedIsActive
                  ? 'this laptop'
                  : selectedCfg?.linked
                    ? 'linked'
                    : selectedCfg?.isOnline
                      ? 'online'
                      : 'offline'}
                {' · '}
                {selectedIsActive
                  ? 'active input'
                  : selectedCfg?.linked
                    ? 'background standby'
                    : 'saved laptop'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedKey(null)}
              className="p-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white shrink-0"
              aria-label="Close screen actions"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {!selectedIsActive && (
              <button
                type="button"
                onClick={() => onSelectHost(selected.host)}
                className="py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold flex items-center justify-center gap-1.5"
              >
                <Zap className="w-3.5 h-3.5" />
                Use this laptop
              </button>
            )}
            {selectedIsActive && onOpenDisplays && (
              <button
                type="button"
                onClick={onOpenDisplays}
                className="py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold flex items-center justify-center gap-1.5"
              >
                <MonitorIcon className="w-3.5 h-3.5" />
                Arrange screens
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setEditingShortIdHost(selected.host);
                setShortIdInput(shortIdFor(selected.host));
              }}
              className="py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-300 text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:border-sky-500"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Label {shortIdFor(selected.host)}
            </button>
          </div>

          {selectedLiveMonitor && (
            <div className="text-[9px] text-slate-500 font-mono">
              current mode: {selectedLiveMonitor.width}×{selectedLiveMonitor.height}
              {' at '}
              +{selectedLiveMonitor.x}+{selectedLiveMonitor.y}
            </div>
          )}
          {!selectedIsActive && (
            <div className="flex items-center gap-1 text-[10px] text-slate-500">
              <ArrowRight className="w-3 h-3" />
              Switching here reloads the deck on that laptop.
            </div>
          )}
        </div>
      )}

      {!selected && layout.length > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
          <Move className="w-3 h-3" />
          Tap a screen for its laptop actions; drag it to move the rectangle.
        </div>
      )}

      {editingShortIdHost && (
        <div className="p-4 rounded-2xl bg-slate-950 border border-sky-500/40 space-y-3">
          <span className="text-xs font-semibold text-sky-300 block">
            Edit short identifier for {nameFor(editingShortIdHost)}
          </span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={4}
              value={shortIdInput}
              onChange={(e) => setShortIdInput(e.target.value.toUpperCase())}
              className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-sky-500 uppercase w-28"
              placeholder="e.g. TM"
            />
            <button
              type="button"
              onClick={() => handleSaveShortId(editingShortIdHost)}
              className="px-4 py-1.5 rounded-xl bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingShortIdHost(null)}
              className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-400 text-xs hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
