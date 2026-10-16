import React, { useRef, useState, useCallback, useEffect } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';

interface HorizontalScrollWheelProps {
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  /** Pixels of travel per single app switch. Larger means less twitchy. */
  sensitivity?: number;
  onAppSwitch?: (direction: 'prev' | 'next') => void;
}

// A step must be wide enough that a full-width swipe cannot cycle every app,
// and small enough that switching still feels deliberate but achievable.
export const MIN_WHEEL_SPACING = 70;
export const MAX_WHEEL_SPACING = 260;
export const DEFAULT_WHEEL_SPACING = 100;

export const HorizontalScrollWheel: React.FC<HorizontalScrollWheelProps> = ({
  hapticsEnabled,
  soundEnabled,
  sensitivity,
  onAppSwitch,
}) => {
  const { triggerWheelTick } = useHaptics(hapticsEnabled, soundEnabled);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);
  const accumulatedDeltaRef = useRef(0);
  const [isActivelyScrubbing, setIsActivelyScrubbing] = useState(false);

  const requested = Number.isFinite(sensitivity) ? (sensitivity as number) : DEFAULT_WHEEL_SPACING;
  const pixelsPerStep = Math.min(MAX_WHEEL_SPACING, Math.max(MIN_WHEEL_SPACING, requested));

  const triggerStep = useCallback(
    (direction: 'prev' | 'next') => {
      triggerWheelTick();
      linuxClient.sendAppSwitch(direction);
      onAppSwitch?.(direction);
    },
    [triggerWheelTick, onAppSwitch]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    lastXRef.current = e.clientX;
    accumulatedDeltaRef.current = 0;
    setIsActivelyScrubbing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const deltaX = e.clientX - lastXRef.current;
    lastXRef.current = e.clientX;

    accumulatedDeltaRef.current += deltaX;

    // Left swipe = Shift+Tab (prev)
    // Right swipe = Tab (next)
    if (accumulatedDeltaRef.current >= pixelsPerStep) {
      triggerStep('next');
      accumulatedDeltaRef.current -= pixelsPerStep;
    } else if (accumulatedDeltaRef.current <= -pixelsPerStep) {
      triggerStep('prev');
      accumulatedDeltaRef.current += pixelsPerStep;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    setIsActivelyScrubbing(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 2) return;
    e.preventDefault();
    accumulatedDeltaRef.current -= delta;

    if (accumulatedDeltaRef.current >= pixelsPerStep) {
      triggerStep('next');
      accumulatedDeltaRef.current = 0;
    } else if (accumulatedDeltaRef.current <= -pixelsPerStep) {
      triggerStep('prev');
      accumulatedDeltaRef.current = 0;
    }
  };

  useEffect(() => {
    const handleMouseUpGlobal = () => {
      isDraggingRef.current = false;
      setIsActivelyScrubbing(false);
    };
    window.addEventListener('pointerup', handleMouseUpGlobal);
    return () => window.removeEventListener('pointerup', handleMouseUpGlobal);
  }, []);

  return (
    <div className="w-full select-none bg-slate-950 px-3 py-3.5 border-b border-slate-900">
      {/* Pure, unmarked, minimalist horizontal roller */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        tabIndex={0}
        role="slider"
        aria-label="Horizontal scroll wheel"
        style={{ height: 'calc(5rem * var(--td-scale, 1))' }}
        className={`relative w-full rounded-2xl overflow-hidden cursor-ew-resize select-none border transition-colors touch-none ${
          isActivelyScrubbing
            ? 'border-sky-500/40 bg-slate-900 shadow-inner'
            : 'border-slate-800/80 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950'
        }`}
      >
        {/* Subtle cylindrical lighting gradient without any markings */}
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-800/30 via-transparent to-black/60" />
      </div>
    </div>
  );
};
