import React, { useRef, useState, useCallback } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';

interface BottomClickButtonsProps {
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  onTriggerDictation: () => void;
}

export const BottomClickButtons: React.FC<BottomClickButtonsProps> = ({
  hapticsEnabled,
  soundEnabled,
  onTriggerDictation,
}) => {
  const { triggerClick, triggerHeavyClick, triggerDictationEngaged } = useHaptics(hapticsEnabled, soundEnabled);

  const [isLeftPressed, setIsLeftPressed] = useState(false);
  const [isRightPressed, setIsRightPressed] = useState(false);
  const [leftHoldProgress, setLeftHoldProgress] = useState(0);
  const [dictationTriggered, setDictationTriggered] = useState(false);

  const leftTimerRef = useRef<number | null>(null);
  const leftStartTimeRef = useRef(0);
  const progressAnimRef = useRef<number | null>(null);

  const LONG_PRESS_DURATION = 420;

  const clearLeftHold = useCallback(() => {
    if (leftTimerRef.current) {
      clearTimeout(leftTimerRef.current);
      leftTimerRef.current = null;
    }
    if (progressAnimRef.current) {
      cancelAnimationFrame(progressAnimRef.current);
      progressAnimRef.current = null;
    }
    setLeftHoldProgress(0);
  }, []);

  const handleLeftDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsLeftPressed(true);
    setDictationTriggered(false);
    leftStartTimeRef.current = Date.now();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const updateProgress = () => {
      const elapsed = Date.now() - leftStartTimeRef.current;
      const progress = Math.min(100, (elapsed / LONG_PRESS_DURATION) * 100);
      setLeftHoldProgress(progress);
      if (progress < 100) {
        progressAnimRef.current = requestAnimationFrame(updateProgress);
      }
    };
    progressAnimRef.current = requestAnimationFrame(updateProgress);

    leftTimerRef.current = window.setTimeout(() => {
      setDictationTriggered(true);
      triggerDictationEngaged();
      onTriggerDictation();
      clearLeftHold();
    }, LONG_PRESS_DURATION);
  };

  const handleLeftUp = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsLeftPressed(false);
    const holdTime = Date.now() - leftStartTimeRef.current;
    clearLeftHold();

    if (!dictationTriggered && holdTime < LONG_PRESS_DURATION) {
      triggerClick();
      linuxClient.sendClick('left', 'click');
    }

    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handleRightDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsRightPressed(true);
    triggerHeavyClick();
    linuxClient.sendClick('right', 'click');
  };

  const handleRightUp = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsRightPressed(false);
  };

  return (
    <div className="w-full bg-slate-950 border-t border-slate-900 p-2 sm:p-2.5 select-none">
      {/* 2 Pure Tactile Click Buttons: Unlabelled, Clean, and Hardware-feeling */}
      <div className="grid grid-cols-2 gap-2 h-16 sm:h-20">
        {/* Left Button */}
        <div
          onPointerDown={handleLeftDown}
          onPointerUp={handleLeftUp}
          onPointerCancel={handleLeftUp}
          role="button"
          tabIndex={0}
          aria-label="Left click"
          className={`relative overflow-hidden rounded-2xl border transition-all duration-75 touch-none cursor-pointer ${
            isLeftPressed
              ? 'bg-sky-600/30 border-sky-400/80 shadow-[inset_0_2px_12px_rgba(56,189,248,0.3)] scale-[0.99]'
              : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-800/90 hover:border-slate-700/80'
          }`}
        >
          {leftHoldProgress > 0 && (
            <div
              className="absolute inset-0 bg-sky-500/20 pointer-events-none transition-all duration-75"
              style={{
                clipPath: `polygon(0 0, ${leftHoldProgress}% 0, ${leftHoldProgress}% 100%, 0 100%)`,
              }}
            />
          )}
          {/* Subtle center tactile pill indicator */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-40">
            <div className="w-8 h-1 rounded-full bg-slate-500" />
          </div>
        </div>

        {/* Right Button */}
        <div
          onPointerDown={handleRightDown}
          onPointerUp={handleRightUp}
          onPointerCancel={handleRightUp}
          role="button"
          tabIndex={0}
          aria-label="Right click"
          className={`relative overflow-hidden rounded-2xl border transition-all duration-75 touch-none cursor-pointer ${
            isRightPressed
              ? 'bg-slate-800/90 border-slate-500 shadow-[inset_0_2px_12px_rgba(148,163,184,0.3)] scale-[0.99]'
              : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-800/90 hover:border-slate-700/80'
          }`}
        >
          {/* Subtle center tactile pill indicator */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-40">
            <div className="w-8 h-1 rounded-full bg-slate-500" />
          </div>
        </div>
      </div>
    </div>
  );
};
