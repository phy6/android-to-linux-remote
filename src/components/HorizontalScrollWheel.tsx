import React, { useRef, useState, useCallback, useEffect } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';

interface HorizontalScrollWheelProps {
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  sensitivity?: number;
  onAppSwitch?: (direction: 'prev' | 'next') => void;
}

export const HorizontalScrollWheel: React.FC<HorizontalScrollWheelProps> = ({
  hapticsEnabled,
  soundEnabled,
  onAppSwitch,
}) => {
  const { triggerWheelTick } = useHaptics(hapticsEnabled, soundEnabled);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);
  const accumulatedDeltaRef = useRef(0);
  const [isActivelyScrubbing, setIsActivelyScrubbing] = useState(false);

  const NOTCH_THRESHOLD = 26; // pixels per app rotation step

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
    if (accumulatedDeltaRef.current >= NOTCH_THRESHOLD) {
      triggerStep('next');
      accumulatedDeltaRef.current -= NOTCH_THRESHOLD;
    } else if (accumulatedDeltaRef.current <= -NOTCH_THRESHOLD) {
      triggerStep('prev');
      accumulatedDeltaRef.current += NOTCH_THRESHOLD;
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

    if (accumulatedDeltaRef.current >= NOTCH_THRESHOLD) {
      triggerStep('next');
      accumulatedDeltaRef.current = 0;
    } else if (accumulatedDeltaRef.current <= -NOTCH_THRESHOLD) {
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
    <div className="w-full select-none bg-slate-950 px-3 py-2 border-b border-slate-900">
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
        className={`relative w-full h-9 rounded-xl overflow-hidden cursor-ew-resize select-none border transition-colors touch-none ${
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
