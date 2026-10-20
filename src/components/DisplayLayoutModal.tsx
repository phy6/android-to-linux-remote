import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Monitor as MonitorIcon,
  RotateCcw,
  RotateCw,
  X,
} from 'lucide-react';
import { DisplayLayoutChange, Monitor, applyDisplayLayout } from '../services/displaysClient';
import { desktopBounds } from '../services/spatialLayout';

export interface DisplayLayoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The connected laptop whose outputs are being arranged. */
  host: string;
  /** Its monitors, as last read from `xrandr`. */
  monitors: Monitor[];
  connected: boolean;
  /** Called after a successful apply with the daemon's refreshed geometry. */
  onApplied?: (monitors: Monitor[]) => void;
}

interface World {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface DragState {
  output: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  /** Virtual pixels per CSS pixel, per axis (the canvas keeps its aspect). */
  scaleX: number;
  scaleY: number;
}

const SNAP = 10;
const DEGREES: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];

function rotationOf(monitor: Monitor): 0 | 90 | 180 | 270 {
  const rotation = monitor.rotation ?? 0;
  return DEGREES.includes(rotation as 0 | 90 | 180 | 270)
    ? (rotation as 0 | 90 | 180 | 270)
    : 0;
}

/**
 * A margin around the current desk so a screen can be dragged outwards without
 * immediately hitting the edge of the canvas. It is fixed while dragging, which
 * keeps the scale under the finger steady.
 */
function worldFor(monitors: Monitor[]): World {
  const bounds = desktopBounds(monitors);
  if (!bounds) return { minX: 0, minY: 0, width: 1920, height: 1080 };
  const padX = Math.max(240, Math.round(bounds.width * 0.18));
  const padY = Math.max(180, Math.round(bounds.height * 0.18));
  return {
    minX: bounds.minX - padX,
    minY: bounds.minY - padY,
    width: bounds.width + padX * 2,
    height: bounds.height + padY * 2,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Pull one edge flush with another screen when it lands close. The 10 px drag
 * grid alone cannot line up e.g. a 1366-wide panel with the next screen, and a
 * small gap becomes dead desktop the pointer cannot cross.
 */
function snapAxis(
  value: number,
  size: number,
  others: Monitor[],
  axis: 'x' | 'y',
  threshold = 32,
): number {
  const starts = others.map((monitor) => monitor[axis]);
  const ends = others.map((monitor) => monitor[axis] + (axis === 'x' ? monitor.width : monitor.height));
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
 * Screen-layout editor for the connected laptop. Each physical output is an
 * icon card placed at its real offset; dragging changes `--pos`, the rotate
 * button changes `--rotate`, and Apply sends the whole layout in one xrandr
 * call. Only the connected host is editable: another laptop's daemon is on a
 * different origin, and a written layout must match the desk the phone drives.
 */
export const DisplayLayoutModal: React.FC<DisplayLayoutModalProps> = ({
  isOpen,
  onClose,
  host,
  monitors,
  connected,
  onApplied,
}) => {
  const [layout, setLayout] = useState<Monitor[]>(monitors);
  const [world, setWorld] = useState<World>(() => worldFor(monitors));
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<string | null>(
    monitors[0]?.output ?? null,
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Re-seed from the daemon whenever the sheet opens or the desk changes. A
  // refresh after Apply arrives through this too, so the drawing stays truthful.
  useEffect(() => {
    if (!isOpen) return;
    setLayout(monitors);
    setWorld(worldFor(monitors));
    setSelectedOutput(monitors[0]?.output ?? null);
    setDrag(null);
    setDirty(false);
    setError(null);
    setNote(null);
  }, [isOpen, monitors]);

  useEffect(() => {
    if (selectedOutput && layout.some((monitor) => monitor.output === selectedOutput)) return;
    setSelectedOutput(layout[0]?.output ?? null);
  }, [layout, selectedOutput]);

  const reset = useCallback(() => {
    setLayout(monitors);
    setWorld(worldFor(monitors));
    setDirty(false);
    setError(null);
    setNote('Reverted to the laptop’s current layout');
  }, [monitors]);

  const moveMonitor = useCallback(
    (output: string, x: number, y: number) => {
      setLayout((prev) =>
        prev.map((monitor) => {
          if (monitor.output !== output) return monitor;
          const nextX = clamp(
            Math.round(x / SNAP) * SNAP,
            world.minX,
            world.minX + world.width - monitor.width,
          );
          const nextY = clamp(
            Math.round(y / SNAP) * SNAP,
            world.minY,
            world.minY + world.height - monitor.height,
          );
          if (nextX === monitor.x && nextY === monitor.y) return monitor;
          return { ...monitor, x: nextX, y: nextY };
        }),
      );
    },
    [world],
  );

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, monitor: Monitor) => {
    if (busy) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    const scaleX = rect && rect.width > 0 ? world.width / rect.width : 1;
    const scaleY = rect && rect.height > 0 ? world.height / rect.height : 1;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelectedOutput(monitor.output);
    setDrag({
      output: monitor.output,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: monitor.x,
      startY: monitor.y,
      scaleX,
      scaleY,
    });
    setNote(null);
    setError(null);
  };

  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - drag.startClientX) * drag.scaleX;
    const dy = (event.clientY - drag.startClientY) * drag.scaleY;
    moveMonitor(drag.output, drag.startX + dx, drag.startY + dy);
    setDirty(true);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const output = drag.output;
    setLayout((prev) =>
      prev.map((monitor) => {
        if (monitor.output !== output) return monitor;
        const others = prev.filter((other) => other.output !== output);
        const x = clamp(
          snapAxis(monitor.x, monitor.width, others, 'x'),
          world.minX,
          world.minX + world.width - monitor.width,
        );
        const y = clamp(
          snapAxis(monitor.y, monitor.height, others, 'y'),
          world.minY,
          world.minY + world.height - monitor.height,
        );
        return x === monitor.x && y === monitor.y ? monitor : { ...monitor, x, y };
      }),
    );
    setDrag(null);
  };

  const rotate = (output: string) => {
    setLayout((prev) =>
      prev.map((monitor) => {
        if (monitor.output !== output) return monitor;
        const rotation = ((rotationOf(monitor) + 90) % 360) as 0 | 90 | 180 | 270;
        // xrandr reports post-rotation WxH, so a quarter turn swaps the box.
        const width = monitor.height;
        const height = monitor.width;
        return {
          ...monitor,
          width,
          height,
          rotation,
          x: clamp(monitor.x, world.minX, world.minX + world.width - width),
          y: clamp(monitor.y, world.minY, world.minY + world.height - height),
        };
      }),
    );
    setDirty(true);
    setNote(null);
    setError(null);
  };

  const changes = useMemo<DisplayLayoutChange[]>(() => {
    if (layout.length === 0) return [];
    const minX = Math.min(...layout.map((monitor) => monitor.x));
    const minY = Math.min(...layout.map((monitor) => monitor.y));
    return layout.map((monitor) => ({
      output: monitor.output,
      // Normalise the world to 0,0; only the relative layout matters to xrandr.
      x: monitor.x - minX,
      y: monitor.y - minY,
      rotation: rotationOf(monitor),
    }));
  }, [layout]);

  // Overlapping CRTCs are allowed by xrandr but make the pointer gate ambiguous
  // and hide part of the desktop, so the editor refuses to apply that.
  const overlap = useMemo(
    () =>
      layout.some((a, i) =>
        layout.some(
          (b, j) =>
            j > i &&
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
        ),
      ),
    [layout],
  );

  const apply = async () => {
    if (!host || !connected || changes.length === 0 || busy || overlap) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await applyDisplayLayout(host, changes);
    setBusy(false);
    if (!result.ok) {
      setError(result.detail);
      return;
    }
    setNote('Layout applied');
    setDirty(false);
    if (result.displays.length > 0) {
      setLayout(result.displays);
      setWorld(worldFor(result.displays));
      onApplied?.(result.displays);
    } else {
      onApplied?.([]);
    }
  };

  if (!isOpen) return null;

  const bounds = desktopBounds(layout);
  const pctX = (value: number) => `${((value - world.minX) / world.width) * 100}%`;
  const pctY = (value: number) => `${((value - world.minY) / world.height) * 100}%`;
  const pctW = (value: number) => `${(value / world.width) * 100}%`;
  const pctH = (value: number) => `${(value / world.height) * 100}%`;
  const aspect = world.width / world.height;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Screen layout"
        onClick={(event) => event.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-slate-950 border border-slate-800 shadow-2xl shadow-black/60 animate-fadeIn"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 shrink-0">
          <div className="min-w-0 flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 flex items-center justify-center shrink-0">
              <MonitorIcon className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white">Screen layout</h2>
              <p className="text-[11px] text-slate-500 font-mono truncate">
                {host || 'not connected'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close screen layout"
            className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-[11px] text-slate-500">
            Drag a screen to move it, pick it below and use Rotate 90° to reorient it. Changes
            are applied to the laptop with xrandr, so pass-off boundaries follow the real desk.
          </p>

          {layout.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 rounded-2xl border border-dashed border-slate-800 text-slate-500">
              <MonitorIcon className="w-6 h-6" />
              <span className="text-xs">No connected screens reported</span>
              <span className="text-[10px]">X11 with xrandr is required; Wayland has no layout API.</span>
            </div>
          ) : (
            <div
              ref={canvasRef}
              className="relative w-full mx-auto overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 select-none"
              style={{
                aspectRatio: `${world.width} / ${world.height}`,
                maxHeight: '52dvh',
                maxWidth: `calc(52dvh * ${aspect})`,
                touchAction: 'none',
                backgroundImage:
                  'radial-gradient(circle at 1px 1px, rgba(51,65,85,0.55) 1px, transparent 0)',
                backgroundSize: '18px 18px',
              }}
            >
              {layout.map((monitor) => {
                const rotation = rotationOf(monitor);
                const active = drag?.output === monitor.output;
                return (
                  <div
                    key={monitor.output}
                    role="button"
                    aria-label={`${monitor.output}, ${monitor.width} by ${monitor.height}, rotation ${rotation} degrees`}
                    onPointerDown={(event) => beginDrag(event, monitor)}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    style={{
                      left: pctX(monitor.x),
                      top: pctY(monitor.y),
                      width: pctW(monitor.width),
                      height: pctH(monitor.height),
                      touchAction: 'none',
                      WebkitTouchCallout: 'none',
                    }}
                    className={`absolute flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border-2 p-1 text-center cursor-grab active:cursor-grabbing ${
                      active
                        ? 'border-sky-300 bg-sky-500/20 shadow-lg shadow-sky-500/20 z-10'
                        : 'border-sky-500/50 bg-slate-900/90 hover:border-sky-400'
                    }`}
                  >
                    <MonitorIcon
                      className="w-4 h-4 text-sky-300 shrink-0 transition-transform duration-200"
                      style={{ transform: `rotate(${rotation}deg)` }}
                    />
                    <span className="text-[9px] font-bold text-slate-100 leading-none truncate max-w-full">
                      {monitor.output}
                    </span>
                    <span className="text-[8px] font-mono text-slate-400 leading-none truncate max-w-full">
                      {monitor.width}×{monitor.height}
                    </span>
                    <span className="absolute bottom-0.5 right-0.5 text-[7px] font-mono text-sky-300/80">
                      {rotation}°
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {layout.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto pb-0.5">
                {layout.map((monitor) => {
                  const selected = selectedOutput === monitor.output;
                  const rotation = rotationOf(monitor);
                  return (
                    <button
                      key={monitor.output}
                      type="button"
                      onClick={() => setSelectedOutput(monitor.output)}
                      className={`shrink-0 flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-mono transition ${
                        selected
                          ? 'bg-sky-600 border-sky-500 text-white'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <MonitorIcon
                        className="w-3 h-3 shrink-0"
                        style={{ transform: `rotate(${rotation}deg)` }}
                      />
                      {monitor.output}
                      <span className={selected ? 'text-sky-100/80' : 'text-slate-500'}>
                        {rotation}°
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={!selectedOutput || busy}
                onClick={() => {
                  if (selectedOutput) rotate(selectedOutput);
                }}
                className="shrink-0 flex items-center gap-1 rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 hover:border-sky-500 hover:text-white disabled:opacity-40"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Rotate 90°
              </button>
            </div>
          )}

          {bounds && layout.length > 1 && (
            <p className="text-[10px] text-slate-500 font-mono">
              Desk {bounds.width}×{bounds.height} · {layout.length} screens
            </p>
          )}

          {overlap && (
            <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
              Screens overlap — drag them apart before applying; overlapping outputs make the
              pointer edge ambiguous.
            </p>
          )}
          {error && (
            <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
          {note && !error && !overlap && (
            <p className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {note}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 p-3 border-t border-slate-800 shrink-0">
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!dirty || busy || !connected || changes.length === 0 || overlap}
            className="flex-1 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:active:scale-100 transition"
          >
            <Check className="w-3.5 h-3.5" />
            {busy
              ? 'Applying…'
              : overlap
                ? 'Separate overlapping screens'
                : dirty
                  ? 'Apply layout'
                  : 'Layout matches the laptop'}
          </button>
        </div>
      </div>
    </div>
  );
};
