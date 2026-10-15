import React, { useRef, useState, useCallback, useEffect } from 'react';
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

export const Trackpad: React.FC<TrackpadProps> = ({
  sensitivity,
  acceleration,
  invertScroll,
  tapToClick,
  twoFingerRightClick,
  hapticsEnabled,
  soundEnabled,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { triggerClick, triggerHeavyClick } = useHaptics(hapticsEnabled, soundEnabled);

  // Active touch tracking for multi-touch (1-finger move, 2-finger scroll)
  const activePointersRef = useRef<Map<number, TouchPoint>>(new Map());
  const touchStartTimeRef = useRef<Map<number, number>>(new Map());
  const touchStartPosRef = useRef<Map<number, TouchPoint>>(new Map());
  const hasMovedRef = useRef<Map<number, boolean>>(new Map());

  // Visual ripples and active touches state
  const [visualRipples, setVisualRipples] = useState<VisualRipple[]>([]);
  const [touchState, setTouchState] = useState<'idle' | 'moving' | 'scrolling'>('idle');

  // Acceleration curve function
  const applyAcceleration = useCallback(
    (delta: number) => {
      const sign = Math.sign(delta);
      const abs = Math.abs(delta);
      // Non-linear power curve for fine control at low speeds and swift leaps at high speeds
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

    // Check if movement exceeds jitter threshold (3px)
    if (startPos) {
      const totalDist = Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y);
      if (totalDist > 4) {
        hasMovedRef.current.set(e.pointerId, true);
      }
    }

    // Update position
    activePointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

    const count = activePointersRef.current.size;

    if (count === 1) {
      // 1-FINGER: MOUSE MOVEMENT
      const accelDx = applyAcceleration(rawDx);
      const accelDy = applyAcceleration(rawDy);
      linuxClient.sendMove(accelDx, accelDy);
      setTouchState('moving');
    } else if (count === 2) {
      // 2-FINGER: SCROLLING
      // Calculate average delta between the 2 fingers
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

    // Check for Tap-To-Click (short duration and minimal movement)
    if (elapsed < 240 && !hasMoved) {
      if (initialCount === 2 && twoFingerRightClick) {
        // Two finger tap = Right click
        triggerHeavyClick();
        linuxClient.sendClick('right', 'click');
      } else if (initialCount === 1 && tapToClick) {
        // One finger tap = Left click
        triggerClick();
        linuxClient.sendClick('left', 'click');
      }
    }

    activePointersRef.current.delete(e.pointerId);
    touchStartTimeRef.current.delete(e.pointerId);
    touchStartPosRef.current.delete(e.pointerId);
    hasMovedRef.current.delete(e.pointerId);

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

  // Clean up pointers if canceled
  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    touchStartTimeRef.current.delete(e.pointerId);
    touchStartPosRef.current.delete(e.pointerId);
    hasMovedRef.current.delete(e.pointerId);
    if (activePointersRef.current.size === 0) {
      setTouchState('idle');
    }
  };

  useEffect(() => {
    const handleGlobalUp = () => {
      activePointersRef.current.clear();
      setTouchState('idle');
    };
    window.addEventListener('pointerup', handleGlobalUp);
    return () => window.removeEventListener('pointerup', handleGlobalUp);
  }, []);

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className="relative flex-1 w-full min-h-[280px] bg-slate-900/40 select-none overflow-hidden touch-none cursor-crosshair flex flex-col items-center justify-center border-y border-slate-800/60"
      style={{
        backgroundImage: `radial-gradient(circle, rgba(148, 163, 184, 0.08) 1.5px, transparent 1.5px)`,
        backgroundSize: '24px 24px',
      }}
    >
      {/* Subtle glass reflection edge */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-600/30 to-transparent pointer-events-none" />

      {/* Ripple Animations */}
      {visualRipples.map((ripple) => (
        <span
          key={ripple.id}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none border border-sky-400/60 bg-sky-500/20 animate-ping"
          style={{
            left: ripple.x,
            top: ripple.y,
            width: 48,
            height: 48,
            animationDuration: '450ms',
          }}
        />
      ))}

      {/* Center Subtle Trackpad Alignment Dot */}
      <div className="pointer-events-none flex flex-col items-center justify-center opacity-30 transition-opacity duration-300">
        <div className="w-1.5 h-1.5 rounded-full bg-slate-500" />
      </div>

      {/* Subtle corner target brackets */}
      <div className="absolute top-3 left-3 w-3 h-3 border-t border-l border-slate-700/40 pointer-events-none" />
      <div className="absolute top-3 right-3 w-3 h-3 border-t border-r border-slate-700/40 pointer-events-none" />
      <div className="absolute bottom-3 left-3 w-3 h-3 border-b border-l border-slate-700/40 pointer-events-none" />
      <div className="absolute bottom-3 right-3 w-3 h-3 border-b border-r border-slate-700/40 pointer-events-none" />
    </div>
  );
};
