import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppWindow } from 'lucide-react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import { useIconObjectUrl } from '../hooks/useIconObjectUrl';
import {
  HostWindow,
  WindowDevice,
  fetchWindows,
  focusWindow as focusWindowOnHost,
  windowIconUrl,
} from '../services/windowsClient';

interface HorizontalScrollWheelProps {
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  /** Pixels of travel per single window step. Larger means less twitchy. */
  sensitivity?: number;
  /** Fallback when the native shell has not supplied a device list yet. */
  host?: string;
  /** Every online laptop whose Alt+Tab list should be merged into the wheel. */
  devices?: WindowDevice[];
  /** Only used when no laptop can expose an Alt+Tab window list (e.g. Wayland). */
  onAppSwitch?: (direction: 'prev' | 'next') => void;
  /** Fired after a step tries to focus a window, so the deck can explain a miss. */
  onWindowSelect?: (item: HostWindow, ok: boolean) => void;
}

// A step must be wide enough that a full-width swipe cannot cycle every app,
// and small enough that switching still feels deliberate but achievable.
export const MIN_WHEEL_SPACING = 70;
export const MAX_WHEEL_SPACING = 260;
export const DEFAULT_WHEEL_SPACING = 100;

/** At most four cells across, so a regular phone shows 3–4 real icons. */
const CELLS_VISIBLE = 4;
const WINDOW_REFRESH_MS = 5000;
const FOCUS_DEBOUNCE_MS = 140;

const WheelIcon: React.FC<{ host: string; item: HostWindow; active: boolean }> = ({
  host,
  item,
  active,
}) => {
  const url = useIconObjectUrl(windowIconUrl(item.host || host, item));

  return (
    <div
      className={`flex flex-col items-center gap-1 transition-all duration-200 ${
        active ? 'scale-105' : 'scale-95'
      }`}
      style={{
        width: 'min(calc(64px * var(--td-scale, 1)), 78%)',
      }}
      title={`${item.appName}${item.deviceLabel ? ` · ${item.deviceLabel}` : ''}${
        item.title ? ` — ${item.title}` : ''
      }`}
      aria-label={`${item.appName}${item.title ? `, ${item.title}` : ''}${
        item.deviceLabel ? ` on ${item.deviceLabel}` : ''
      }`}
    >
      <div className="relative w-full" style={{ aspectRatio: '1 / 1' }}>
        <div
          className={`absolute inset-0 flex items-center justify-center overflow-hidden rounded-[1.15rem] border ${
            active
              ? 'border-sky-400/70 bg-sky-400/10 shadow-[0_0_20px_rgba(56,189,248,0.22)]'
              : 'border-slate-700/60 bg-slate-900/75'
          }`}
        >
          {url ? (
            <img
              src={url}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-contain p-[14%] transition-[filter] duration-200"
              style={{
                // Muted to sit inside the slate deck; the shortcut panel keeps
                // the full-colour icon because it is a launcher, not a status.
                filter: active
                  ? 'saturate(0.7) brightness(1.05)'
                  : 'saturate(0.35) brightness(0.82)',
              }}
            />
          ) : (
            <span
              className={`text-base font-semibold ${
                active ? 'text-sky-200' : 'text-slate-300'
              }`}
            >
              {(item.appName || item.title || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        {item.deviceLabel && (
          <span
            className={`absolute right-0 top-0 z-10 rounded-full border px-1.5 py-[1px] text-[8px] font-bold uppercase leading-none tracking-wide ${
              active
                ? 'border-sky-400/50 bg-sky-500/20 text-sky-200'
                : 'border-slate-700/70 bg-slate-950/90 text-slate-400'
            }`}
          >
            {item.deviceLabel}
          </span>
        )}
      </div>
      <span
        className={`w-full truncate text-center text-[9px] font-medium leading-tight ${
          active ? 'text-sky-100' : 'text-slate-400'
        }`}
      >
        {item.appName}
      </span>
    </div>
  );
};

export const HorizontalScrollWheel: React.FC<HorizontalScrollWheelProps> = ({
  hapticsEnabled,
  soundEnabled,
  sensitivity,
  host,
  devices,
  onAppSwitch,
  onWindowSelect,
}) => {
  const { triggerWheelTick } = useHaptics(hapticsEnabled, soundEnabled);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartIndexRef = useRef(0);
  const dragOffsetRef = useRef(0);
  const lastTickPosRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const indexRef = useRef(0);
  const selectedKeyRef = useRef<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const pendingFocusRef = useRef<{ item: HostWindow; direction: 'prev' | 'next' } | null>(
    null,
  );
  const focusSeqRef = useRef(0);
  const [isActivelyScrubbing, setIsActivelyScrubbing] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [width, setWidth] = useState(0);
  const [items, setItems] = useState<HostWindow[]>([]);
  const [index, setIndex] = useState(0);

  const requested = Number.isFinite(sensitivity) ? (sensitivity as number) : DEFAULT_WHEEL_SPACING;
  const pixelsPerStep = Math.min(MAX_WHEEL_SPACING, Math.max(MIN_WHEEL_SPACING, requested));

  const effectiveDevices = useMemo<WindowDevice[]>(() => {
    if (devices && devices.length) return devices;
    if (!host) return [];
    return [{ host, label: '', name: host, active: true }];
  }, [devices, host]);
  // The effect below keys off the device set, not array identity, so a parent
  // that rebuilds the array each render does not restart the poll loop.
  const deviceKey = effectiveDevices
    .map((d) => `${d.host}|${d.label}|${d.active}`)
    .join('||');

  useEffect(() => {
    if (!effectiveDevices.length) {
      setItems([]);
      return;
    }
    let alive = true;
    const load = async () => {
      const results = await Promise.all(
        effectiveDevices.map(async (device) => ({
          device,
          list: await fetchWindows(device.host),
        })),
      );
      if (!alive || isDraggingRef.current) return;
      const next: HostWindow[] = [];
      for (const { device, list } of results) {
        for (const window of list.windows) {
          next.push({
            ...window,
            host: device.host,
            deviceLabel: device.label,
            deviceName: device.name,
            deviceActive: device.active,
            key: `${device.host}|${window.id}`,
          });
        }
      }
      setItems((previous) => {
        if (
          previous.length === next.length &&
          previous.every(
            (item, i) =>
              item.key === next[i].key &&
              item.title === next[i].title &&
              item.active === next[i].active &&
              item.deviceLabel === next[i].deviceLabel,
          )
        ) {
          return previous;
        }
        return next;
      });
    };
    void load();
    const timer = window.setInterval(load, WINDOW_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // effectiveDevices is represented by deviceKey; keying off the array would
    // restart the interval whenever the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);

  // Keep the icon the user picked under the centre even when a refresh reorders
  // its laptop's Alt+Tab list (focusing a window moves it to the front). Layout
  // effect so the strip does not paint one frame on the wrong icon.
  useLayoutEffect(() => {
    if (!items.length) {
      indexRef.current = 0;
      setIndex(0);
      selectedKeyRef.current = null;
      return;
    }
    const selected = selectedKeyRef.current;
    const found = selected ? items.findIndex((item) => item.key === selected) : -1;
    const nextIndex =
      found >= 0 ? found : Math.min(indexRef.current, items.length - 1);
    indexRef.current = nextIndex;
    setIndex(nextIndex);
    if (found < 0) selectedKeyRef.current = items[nextIndex]?.key ?? null;
  }, [items]);

  // The strip is sized from the live container so four cells always fill a
  // regular phone width exactly; no breakpoint list to keep in sync.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    },
    [],
  );

  const scheduleFocus = useCallback(
    (item: HostWindow, direction: 'prev' | 'next') => {
      pendingFocusRef.current = { item, direction };
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        const pending = pendingFocusRef.current;
        if (!pending) return;
        const seq = ++focusSeqRef.current;
        void focusWindowOnHost(pending.item.host, pending.item).then((ok) => {
          if (seq !== focusSeqRef.current) return;
          if (!ok && pending.item.deviceActive) {
            // The active laptop could not focus by id; its Alt+Tab shortcut is
            // still a useful last resort.
            linuxClient.sendAppSwitch(pending.direction);
          }
          onWindowSelect?.(pending.item, ok);
        });
      }, FOCUS_DEBOUNCE_MS);
    },
    [onWindowSelect],
  );

  const commitIndex = useCallback(
    (nextIndex: number, item: HostWindow | undefined, direction: 'prev' | 'next') => {
      indexRef.current = nextIndex;
      setIndex(nextIndex);
      if (item) {
        selectedKeyRef.current = item.key;
        scheduleFocus(item, direction);
      }
    },
    [scheduleFocus],
  );

  const triggerStep = useCallback(
    (direction: 'prev' | 'next') => {
      triggerWheelTick();
      if (!items.length) {
        // Wayland/old daemon: no window list, so retain Alt+Tab behaviour.
        linuxClient.sendAppSwitch(direction);
        onAppSwitch?.(direction);
        return;
      }
      const nextIndex =
        (indexRef.current + (direction === 'next' ? 1 : -1) + items.length) %
        items.length;
      commitIndex(nextIndex, items[nextIndex], direction);
    },
    [triggerWheelTick, items, onAppSwitch, commitIndex],
  );

  const finishDrag = (event?: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsActivelyScrubbing(false);

    const dx =
      event !== undefined ? event.clientX - dragStartXRef.current : dragOffsetRef.current;
    const cell = width > 0 ? width / CELLS_VISIBLE : 0;
    const steps = cell > 0 ? Math.round(-dx / cell) : 0;
    const count = items.length;
    const start = dragStartIndexRef.current;

    setDragOffset(0);
    dragOffsetRef.current = 0;

    if (!count) {
      if (steps !== 0) {
        const direction = steps > 0 ? 'next' : 'prev';
        linuxClient.sendAppSwitch(direction);
        onAppSwitch?.(direction);
      }
      return;
    }

    let target = start + steps;
    if (cell < 1) target = start;
    target =
      count >= CELLS_VISIBLE
        ? ((target % count) + count) % count
        : Math.max(0, Math.min(count - 1, target));

    if (target !== start) {
      commitIndex(target, items[target], steps > 0 ? 'next' : 'prev');
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    // Capture on the wheel itself, not the icon under the finger: retargeted
    // moves then keep bubbling here even when the drag leaves the icon.
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartIndexRef.current = indexRef.current;
    dragOffsetRef.current = 0;
    lastTickPosRef.current = count >= CELLS_VISIBLE ? count + indexRef.current : indexRef.current;
    setDragOffset(0);
    setIsActivelyScrubbing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Older WebViews can refuse capture; the global pointerup still resets.
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const cell = width > 0 ? width / CELLS_VISIBLE : 0;
    const count = items.length;
    const loop = count >= CELLS_VISIBLE;
    const maxCells = loop ? 2 : Math.max(1, count - 1);
    const maxDrag = cell * maxCells;
    const raw = e.clientX - dragStartXRef.current;
    const nextOffset = Math.max(-maxDrag, Math.min(maxDrag, raw));
    dragOffsetRef.current = nextOffset;
    setDragOffset(nextOffset);

    if (cell > 0 && count) {
      const base = loop ? count + dragStartIndexRef.current : dragStartIndexRef.current;
      const centerPos = base + Math.round(-nextOffset / cell);
      if (centerPos !== lastTickPosRef.current) {
        triggerWheelTick();
        lastTickPosRef.current = centerPos;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    finishDrag(e);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handlePointerCancel = () => {
    // A cancelled gesture should snap back, not select whatever was under the
    // finger when the OS interrupted us.
    isDraggingRef.current = false;
    setIsActivelyScrubbing(false);
    setDragOffset(0);
    dragOffsetRef.current = 0;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 2) return;
    e.preventDefault();
    wheelAccumRef.current -= delta;

    if (wheelAccumRef.current >= pixelsPerStep) {
      triggerStep('next');
      wheelAccumRef.current = 0;
    } else if (wheelAccumRef.current <= -pixelsPerStep) {
      triggerStep('prev');
      wheelAccumRef.current = 0;
    }
  };

  useEffect(() => {
    const handleMouseUpGlobal = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsActivelyScrubbing(false);
      setDragOffset(0);
      dragOffsetRef.current = 0;
    };
    window.addEventListener('pointerup', handleMouseUpGlobal);
    window.addEventListener('pointercancel', handleMouseUpGlobal);
    return () => {
      window.removeEventListener('pointerup', handleMouseUpGlobal);
      window.removeEventListener('pointercancel', handleMouseUpGlobal);
    };
  }, []);

  const count = items.length;
  // With four or more windows, repeat the list around the selection so the
  // wheel never hits a dead end. With fewer, centre the real list instead of
  // showing the same icon over and over.
  const loop = count >= CELLS_VISIBLE;
  const display = useMemo(
    () => (loop ? [...items, ...items, ...items] : items),
    [items, loop],
  );
  const basePos = loop ? count + index : index;
  const cellWidth = width > 0 ? width / CELLS_VISIBLE : 0;
  // The strip itself follows the finger; the item nearest the centre is the
  // one that will be selected on release.
  const previewSteps = cellWidth > 0 ? Math.round(-dragOffset / cellWidth) : 0;
  const previewPos = basePos + previewSteps;
  const centerPos = loop
    ? previewPos
    : Math.max(0, Math.min(Math.max(0, count - 1), previewPos));
  const offsetX = cellWidth > 0 ? width / 2 - (basePos + 0.5) * cellWidth : 0;
  const centerIndex = count
    ? loop
      ? ((centerPos % count) + count) % count
      : centerPos
    : 0;
  const activeItem = count ? items[centerIndex] : null;

  return (
    <div className="w-full select-none bg-slate-950 px-3 py-3.5 border-b border-slate-900">
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            triggerStep('prev');
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            triggerStep('next');
          }
        }}
        tabIndex={0}
        role="slider"
        aria-label="Cross-device Alt+Tab wheel"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={count ? centerIndex : 0}
        aria-valuetext={
          activeItem
            ? `${activeItem.appName} on ${activeItem.deviceLabel || activeItem.deviceName}`
            : 'No windows loaded'
        }
        style={{ height: 'calc(7.5rem * var(--td-scale, 1))' }}
        className={`relative w-full rounded-2xl overflow-hidden cursor-ew-resize select-none border transition-colors touch-none ${
          isActivelyScrubbing
            ? 'border-sky-500/40 bg-slate-900 shadow-inner'
            : 'border-slate-800/80 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950'
        }`}
      >
        {/* Subtle cylindrical lighting, kept under the icons. */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-700/20 via-transparent to-black/50" />

        {count === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2.5 opacity-40">
            {[0, 1, 2, 3].map((slot) => (
              <div
                key={slot}
                className="flex items-center justify-center rounded-[1.15rem] border border-slate-700/60 bg-slate-900/60"
                style={{
                  width: 'min(calc(64px * var(--td-scale, 1)), 20%)',
                  aspectRatio: '1 / 1',
                }}
              >
                <AppWindow className="h-5 w-5 text-slate-600" />
              </div>
            ))}
          </div>
        ) : (
          <div
            className={`absolute inset-y-0 left-0 flex items-center will-change-transform ${
              isActivelyScrubbing ? '' : 'transition-transform duration-200 ease-out'
            }`}
            style={{
              width: `${cellWidth * display.length}px`,
              transform: `translate3d(${offsetX + dragOffset}px, 0, 0)`,
            }}
          >
            {display.map((item, pos) => {
              const active = pos === centerPos;
              const distance = Math.abs(pos - centerPos);
              return (
                <div
                  key={`${item.key}-${pos}`}
                  className="flex h-full shrink-0 items-center justify-center"
                  style={{
                    width: `${cellWidth}px`,
                    opacity: active ? 1 : distance === 1 ? 0.62 : 0.28,
                  }}
                >
                  <WheelIcon host={item.host} item={item} active={active} />
                </div>
              );
            })}
          </div>
        )}

        {/* Soft edges so the next icon peeks in without looking clipped. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-slate-950 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-slate-950 to-transparent" />
      </div>
      {/* The focused window's title is the one detail an icon cannot convey. */}
      <div
        className={`mt-1 h-4 truncate px-2 text-center text-[10px] leading-4 ${
          activeItem ? 'text-slate-400' : 'text-slate-600'
        }`}
        aria-live="polite"
      >
        {activeItem
          ? activeItem.title && activeItem.title !== activeItem.appName
            ? activeItem.title
            : activeItem.appName
          : count
            ? ''
            : 'No windows loaded'}
      </div>
    </div>
  );
};
