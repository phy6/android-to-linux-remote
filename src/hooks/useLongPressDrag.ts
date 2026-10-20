// Long-press drag for touch. HTML5 drag-and-drop never fires on a phone, and the
// hover overlays it usually pairs with never show either, so both the spatial
// switcher and the file list move with raw pointer events instead.
//
// The press has to survive the two things a real finger does: it drifts a little
// (so a small movement must not cancel the hold) and it arrives from an element
// inside a scroll container (so once the hold fires, the page must stop
// scrolling under the ghost). The container is only frozen *after* the hold
// wins, which is why the touchmove guard is installed on pointerdown and reads
// the armed flag rather than being attached late.

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the finger must stay put before the drag takes over. */
export const LONG_PRESS_MS = 320;
/** Movement past this cancels the hold and lets the list scroll/click normally. */
const MOVE_CANCEL_PX = 10;

export interface DragPoint {
  x: number;
  y: number;
}

export interface LongPressDragHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  /** Swallows the click the browser synthesises after a completed drag. */
  onClickCapture: (e: React.MouseEvent) => void;
}

interface UseLongPressDragOptions<T> {
  /** The hold succeeded: the drag is live and `active` is now non-null. */
  onArm?: (payload: T, point: DragPoint) => void;
  /** Released over a target; the caller hit-tests the point. */
  onDrop: (payload: T, point: DragPoint) => void;
  /** Long-press drag abandoned (pointercancel, e.g. the system took the gesture). */
  onCancel?: (payload: T) => void;
  holdMs?: number;
}

export function useLongPressDrag<T>({
  onArm,
  onDrop,
  onCancel,
  holdMs = LONG_PRESS_MS,
}: UseLongPressDragOptions<T>) {
  const [active, setActive] = useState<T | null>(null);
  const [point, setPoint] = useState<DragPoint | null>(null);

  const pressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    payload: T;
    armed: boolean;
  } | null>(null);
  const timerRef = useRef<number | null>(null);
  const touchGuardRef = useRef<((e: TouchEvent) => void) | null>(null);
  const swallowClickRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const detachGuard = useCallback(() => {
    if (touchGuardRef.current) {
      document.removeEventListener('touchmove', touchGuardRef.current);
      touchGuardRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    detachGuard();
    pressRef.current = null;
    setActive(null);
    setPoint(null);
  }, [clearTimer, detachGuard]);

  useEffect(() => reset, [reset]);

  const begin = useCallback(
    (payload: T) => (e: React.PointerEvent) => {
      // Ignore secondary mouse buttons; touch/pen have no meaningful button.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      reset();

      pressRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        payload,
        armed: false,
      };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Some synthetic pointers cannot be captured; the drag still works.
      }

      if (e.pointerType !== 'mouse') {
        const guard = (ev: TouchEvent) => {
          if (pressRef.current?.armed) ev.preventDefault();
        };
        touchGuardRef.current = guard;
        document.addEventListener('touchmove', guard, { passive: false });
      }

      timerRef.current = window.setTimeout(() => {
        const press = pressRef.current;
        if (!press || press.armed) return;
        press.armed = true;
        const at = { x: press.startX, y: press.startY };
        setActive(payload);
        setPoint(at);
        onArm?.(payload, at);
      }, holdMs);
    },
    [holdMs, onArm, reset],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press || e.pointerId !== press.pointerId) return;
    if (!press.armed) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) > MOVE_CANCEL_PX) {
        // A finger that moves before the hold was aiming at a scroll or a tap.
        clearTimer();
        detachGuard();
        pressRef.current = null;
      }
      return;
    }
    setPoint({ x: e.clientX, y: e.clientY });
  }, [clearTimer, detachGuard]);

  const finishPress = useCallback(
    (e: React.PointerEvent, drop: boolean) => {
      const press = pressRef.current;
      if (!press || e.pointerId !== press.pointerId) return;
      const wasArmed = press.armed;
      const at = { x: e.clientX, y: e.clientY };
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be gone.
      }
      clearTimer();
      detachGuard();
      pressRef.current = null;
      setActive(null);
      setPoint(null);

      if (!wasArmed) return;
      // The browser still fires a click for a long press that never moved; the
      // caller's tap handler must not see it as well.
      swallowClickRef.current = true;
      if (drop) onDrop(press.payload, at);
      else onCancel?.(press.payload);
    },
    [clearTimer, detachGuard, onCancel, onDrop],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => finishPress(e, true), [finishPress]);
  const onPointerCancel = useCallback((e: React.PointerEvent) => finishPress(e, false), [finishPress]);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handlers: LongPressDragHandlers = {
    onPointerDown: () => {
      // Replaced per element by `begin`; kept for type completeness.
    },
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  };

  return { begin, handlers, active, point };
}

/**
 * The element under a drag point, ignoring the (pointer-events-none) ghost.
 * Used to find a `[data-drop-*]` target on release.
 */
export function dropTargetAt(point: DragPoint, attribute: string): HTMLElement | null {
  const el = document.elementFromPoint(point.x, point.y);
  if (!el) return null;
  return (el.closest(`[${attribute}]`) as HTMLElement | null) ?? null;
}
