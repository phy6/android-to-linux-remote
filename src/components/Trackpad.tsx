import React, { useRef, useState, useCallback } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';

interface TrackpadProps {
  sensitivity: number;
  acceleration: number;
  invertScroll: boolean;
  tapToClick: boolean;
  twoFingerRightClick: boolean;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  onPassOff?: (direction: 'left' | 'right' | 'top' | 'bottom') => void;
  activeAdjacentDirections?: Array<'left' | 'right' | 'top' | 'bottom'>;
}

interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

interface VisualRipple {
  id: number;
  x: number;
  y: number;
}

const EDGE_PUSH_THRESHOLD = 32; // Pixels pushed into border to trigger pass-off
const EDGE_MARGIN = 28; // Margin from container border

export const Trackpad: React.FC<TrackpadProps> = ({
  sensitivity,
  acceleration,
  invertScroll,
  tapToClick,
  twoFingerRightClick,
  hapticsEnabled,
  soundEnabled,
  onPassOff,
  activeAdjacentDirections = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { triggerClick, triggerHeavyClick } = useHaptics(hapticsEnabled, soundEnabled);

  // Active touch tracking for multi-touch (1-finger move, 2-finger scroll)
  const activePointersRef = useRef<Map<number, TouchPoint>>(new Map());
  const touchStartTimeRef = useRef<Map<number, number>>(new Map());
  const touchStartPosRef = useRef<Map<number, TouchPoint>>(new Map());
  const hasMovedRef = useRef<Map<number, boolean>>(new Map());

  // Edge push tracking for spatial screen pass-off
  const edgePushRef = useRef<{ direction: 'left' | 'right' | 'top' | 'bottom'; distance: number } | null>(null);
  const activeEdgePushRef = useRef<'left' | 'right' | 'top' | 'bottom' | null>(null);
  const [activeEdgePush, setActiveEdgePush] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null);
  // One pass-off per gesture: latched until the pointer lifts.
  const pushedOffRef = useRef(false);
  // Cached on pointer-down so we never call getBoundingClientRect per move.
  const containerRectRef = useRef<DOMRect | null>(null);

  const setEdgePush = useCallback((dir: 'left' | 'right' | 'top' | 'bottom' | null) => {
    if (activeEdgePushRef.current === dir) return;
    activeEdgePushRef.current = dir;
    setActiveEdgePush(dir);
  }, []);

  // Visual ripples and active touches state
  const [visualRipples, setVisualRipples] = useState<VisualRipple[]>([]);
  const [touchState, setTouchState] = useState<'idle' | 'moving' | 'scrolling'>('idle');

  // Acceleration curve function
  const applyAcceleration = useCallback(
    (delta: number) => {
      const sign = Math.sign(delta);
      const abs = Math.abs(delta);
      const accelerated = Math.pow(abs, acceleration) * sensitivity;
      return sign * accelerated;
    },
    [acceleration, sensitivity]
  );

  const addRipple = (x: number, y: number) => {
    const id = Date.now() + Math.random();
    setVisualRipples((prev) => [...prev.slice(-4), { id, x, y }]);
    setTimeout(() => {
      setVisualRipples((prev) => prev.filter((r) => r.id !== id));
    }, 450);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const localX = rect ? e.clientX - rect.left : e.clientX;
    const localY = rect ? e.clientY - rect.top : e.clientY;
    containerRectRef.current = rect ?? null;
    pushedOffRef.current = false;

    activePointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    touchStartTimeRef.current.set(e.pointerId, Date.now());
    touchStartPosRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    hasMovedRef.current.set(e.pointerId, false);

    addRipple(localX, localY);

    const count = activePointersRef.current.size;
    if (count === 1) {
      setTouchState('moving');
    } else if (count >= 2) {
      setTouchState('scrolling');
    }

    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!activePointersRef.current.has(e.pointerId)) return;

    const prevPos = activePointersRef.current.get(e.pointerId)!;
    const startPos = touchStartPosRef.current.get(e.pointerId);

    const rawDx = e.clientX - prevPos.x;
    const rawDy = e.clientY - prevPos.y;

    if (startPos) {
      const totalDist = Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y);
      if (totalDist > 4) {
        hasMovedRef.current.set(e.pointerId, true);
      }
    }

    activePointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

    const count = activePointersRef.current.size;

    if (count === 1) {
      // 1-FINGER: MOUSE MOVEMENT
      const accelDx = applyAcceleration(rawDx);
      const accelDy = applyAcceleration(rawDy);
      linuxClient.sendMove(accelDx, accelDy);
      setTouchState('moving');

      // Check Edge Pass-off if adjacent laptop exists in that direction
      if (containerRectRef.current && onPassOff && activeAdjacentDirections.length > 0 && !pushedOffRef.current) {
        const rect = containerRectRef.current;
        let pushDir: 'left' | 'right' | 'top' | 'bottom' | null = null;

        if (e.clientX <= rect.left + EDGE_MARGIN && rawDx < -2 && activeAdjacentDirections.includes('left')) {
          pushDir = 'left';
        } else if (e.clientX >= rect.right - EDGE_MARGIN && rawDx > 2 && activeAdjacentDirections.includes('right')) {
          pushDir = 'right';
        } else if (e.clientY <= rect.top + EDGE_MARGIN && rawDy < -2 && activeAdjacentDirections.includes('top')) {
          pushDir = 'top';
        } else if (e.clientY >= rect.bottom - EDGE_MARGIN && rawDy > 2 && activeAdjacentDirections.includes('bottom')) {
          pushDir = 'bottom';
        }

        if (pushDir) {
          const delta = Math.max(Math.abs(rawDx), Math.abs(rawDy));
          if (!edgePushRef.current || edgePushRef.current.direction !== pushDir) {
            edgePushRef.current = { direction: pushDir, distance: delta };
          } else {
            edgePushRef.current.distance += delta;
          }

          if (!edgePushRef.current || edgePushRef.current.distance >= EDGE_PUSH_THRESHOLD) {
            triggerHeavyClick();
            pushedOffRef.current = true;
            edgePushRef.current = null;
            setEdgePush(null);
            onPassOff(pushDir);
          } else {
            setEdgePush(pushDir);
          }
        } else {
          edgePushRef.current = null;
          setEdgePush(null);
        }
      }
    } else if (count === 2) {
      // 2-FINGER: SCROLLING
      const scrollMultiplier = invertScroll ? -1 : 1;
      const scrollDx = rawDx * sensitivity * scrollMultiplier;
      const scrollDy = rawDy * sensitivity * scrollMultiplier;
      linuxClient.sendScroll(scrollDx, scrollDy);
      setTouchState('scrolling');
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startTime = touchStartTimeRef.current.get(e.pointerId) || 0;
    const hasMoved = hasMovedRef.current.get(e.pointerId) || false;
    const elapsed = Date.now() - startTime;
    const initialCount = activePointersRef.current.size;

    if (elapsed < 240 && !hasMoved) {
      if (initialCount === 2 && twoFingerRightClick) {
        triggerHeavyClick();
        linuxClient.sendClick('right', 'click');
      } else if (initialCount === 1 && tapToClick) {
        triggerClick();
        linuxClient.sendClick('left', 'click');
      }
    }

    activePointersRef.current.delete(e.pointerId);
    touchStartTimeRef.current.delete(e.pointerId);
    touchStartPosRef.current.delete(e.pointerId);
    hasMovedRef.current.delete(e.pointerId);

    edgePushRef.current = null;
    pushedOffRef.current = false;
    containerRectRef.current = null;
    setEdgePush(null);

    if (activePointersRef.current.size === 0) {
      setTouchState('idle');
    } else if (activePointersRef.current.size === 1) {
      setTouchState('moving');
    }

    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  // A cancelled pointer must not be interpreted as a tap — just forget it.
  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    touchStartTimeRef.current.delete(e.pointerId);
    touchStartPosRef.current.delete(e.pointerId);
    hasMovedRef.current.delete(e.pointerId);
    edgePushRef.current = null;
    pushedOffRef.current = false;
    containerRectRef.current = null;
    setEdgePush(null);
    if (activePointersRef.current.size === 0) {
      setTouchState('idle');
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className="absolute inset-0 touch-none select-none overflow-hidden cursor-crosshair bg-slate-950 flex flex-col justify-between"
    >
      {/* Visual Edge Pass-off Indicators */}
      {activeAdjacentDirections.includes('left') && (
        <div
          className={`absolute left-0 inset-y-0 w-3 bg-gradient-to-r from-sky-500/50 to-transparent transition-opacity duration-150 pointer-events-none ${
            activeEdgePush === 'left' ? 'opacity-100 w-6 from-sky-400' : 'opacity-30'
          }`}
        />
      )}
      {activeAdjacentDirections.includes('right') && (
        <div
          className={`absolute right-0 inset-y-0 w-3 bg-gradient-to-l from-sky-500/50 to-transparent transition-opacity duration-150 pointer-events-none ${
            activeEdgePush === 'right' ? 'opacity-100 w-6 from-sky-400' : 'opacity-30'
          }`}
        />
      )}
      {activeAdjacentDirections.includes('top') && (
        <div
          className={`absolute top-0 inset-x-0 h-3 bg-gradient-to-b from-sky-500/50 to-transparent transition-opacity duration-150 pointer-events-none ${
            activeEdgePush === 'top' ? 'opacity-100 h-6 from-sky-400' : 'opacity-30'
          }`}
        />
      )}
      {activeAdjacentDirections.includes('bottom') && (
        <div
          className={`absolute bottom-0 inset-x-0 h-3 bg-gradient-to-t from-sky-500/50 to-transparent transition-opacity duration-150 pointer-events-none ${
            activeEdgePush === 'bottom' ? 'opacity-100 h-6 from-sky-400' : 'opacity-30'
          }`}
        />
      )}

      {/* Subtle Grid Dot Accent for Touch Context */}
      <div className="absolute inset-0 opacity-15 bg-[radial-gradient(#38bdf8_1px,transparent_1px)] [background-size:24px_24px] pointer-events-none" />

      {/* Touch Ripples */}
      {visualRipples.map((r) => (
        <span
          key={r.id}
          style={{ left: r.x - 24, top: r.y - 24 }}
          className="absolute w-12 h-12 rounded-full border border-sky-400/60 bg-sky-500/10 pointer-events-none animate-ping opacity-75"
        />
      ))}
    </div>
  );
};
