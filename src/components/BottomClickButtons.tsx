import React, { useRef, useState, useCallback } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';

// Global size multiplier for the big thumb controls. Kept here (and re-exported
// for the settings store) so the gesture and the persisted value share bounds.
export const MIN_BUTTON_SCALE = 0.8;
export const MAX_BUTTON_SCALE = 1.5;
export const DEFAULT_BUTTON_SCALE = 1;

// Vertical travel, in pixels, that sweeps the whole MIN→MAX range.
const SCALE_DRAG_RANGE_PX = 280;

interface BottomClickButtonsProps {
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  onTriggerDictation: () => void;
  /** Current global scale, so the drag starts from where the buttons are. */
  buttonScale?: number;
  /** Fired continuously while dragging, for a live preview. */
  onButtonScaleChange?: (scale: number) => void;
  /** Fired once on release, when the size should be persisted. */
  onButtonScaleCommit?: (scale: number) => void;
}

export const BottomClickButtons: React.FC<BottomClickButtonsProps> = ({
  hapticsEnabled,
  soundEnabled,
  onTriggerDictation,
  buttonScale = DEFAULT_BUTTON_SCALE,
  onButtonScaleChange,
  onButtonScaleCommit,
}) => {
  const { triggerClick, triggerHeavyClick, triggerDictationEngaged } = useHaptics(hapticsEnabled, soundEnabled);

  const [isLeftPressed, setIsLeftPressed] = useState(false);
  const [isRightPressed, setIsRightPressed] = useState(false);
  const [leftHoldProgress, setLeftHoldProgress] = useState(0);
  const [rightHoldProgress, setRightHoldProgress] = useState(0);
  const [dictationTriggered, setDictationTriggered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const leftTimerRef = useRef<number | null>(null);
  const leftStartTimeRef = useRef(0);
  const progressAnimRef = useRef<number | null>(null);

  // Right button doubles as the resize grip: a plain press still right-clicks,
  // but holding it enters resize mode and the vertical drag scales every big
  // control at once.
  const rightTimerRef = useRef<number | null>(null);
  const rightStartTimeRef = useRef(0);
  const rightStartYRef = useRef(0);
  const rightScaleStartRef = useRef(DEFAULT_BUTTON_SCALE);
  const rightScaleRef = useRef(DEFAULT_BUTTON_SCALE);
  const rightResizingRef = useRef(false);
  const rightProgressAnimRef = useRef<number | null>(null);

  const LONG_PRESS_DURATION = 420;
  const RESIZE_LONG_PRESS_DURATION = 500;

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

  const clearRightHold = useCallback(() => {
    if (rightTimerRef.current) {
      clearTimeout(rightTimerRef.current);
      rightTimerRef.current = null;
    }
    if (rightProgressAnimRef.current) {
      cancelAnimationFrame(rightProgressAnimRef.current);
      rightProgressAnimRef.current = null;
    }
    setRightHoldProgress(0);
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
    rightStartTimeRef.current = Date.now();
    rightStartYRef.current = e.clientY;
    rightScaleStartRef.current = buttonScale;
    rightScaleRef.current = buttonScale;
    rightResizingRef.current = false;
    setIsResizing(false);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const updateProgress = () => {
      const elapsed = Date.now() - rightStartTimeRef.current;
      const progress = Math.min(100, (elapsed / RESIZE_LONG_PRESS_DURATION) * 100);
      setRightHoldProgress(progress);
      if (progress < 100) {
        rightProgressAnimRef.current = requestAnimationFrame(updateProgress);
      }
    };
    rightProgressAnimRef.current = requestAnimationFrame(updateProgress);

    rightTimerRef.current = window.setTimeout(() => {
      rightResizingRef.current = true;
      setIsResizing(true);
      triggerHeavyClick();
      clearRightHold();
    }, RESIZE_LONG_PRESS_DURATION);
  };

  const handleRightMove = (e: React.PointerEvent) => {
    if (!rightResizingRef.current) return;
    const dy = e.clientY - rightStartYRef.current;
    const next = Math.min(
      MAX_BUTTON_SCALE,
      Math.max(MIN_BUTTON_SCALE, rightScaleStartRef.current - dy / SCALE_DRAG_RANGE_PX)
    );
    rightScaleRef.current = next;
    onButtonScaleChange?.(next);
  };

  const handleRightUp = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsRightPressed(false);
    const holdTime = Date.now() - rightStartTimeRef.current;
    clearRightHold();

    if (rightResizingRef.current) {
      // Release commits the size the finger left behind.
      onButtonScaleCommit?.(rightScaleRef.current);
      rightResizingRef.current = false;
      setIsResizing(false);
    } else if (holdTime < RESIZE_LONG_PRESS_DURATION) {
      // Tap still means right click.
      triggerHeavyClick();
      linuxClient.sendClick('right', 'click');
    }

    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="w-full bg-slate-950 border-t border-slate-900 p-2.5 sm:p-3 select-none">
      {/* 2 Pure Tactile Click Buttons: Unlabelled, Clean, and Hardware-feeling */}
      <div className="grid grid-cols-2 gap-2.5" style={{ height: 'calc(7.5rem * var(--td-scale, 1))' }}>
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

        {/* Right Button: tap = right click, hold + drag = resize the big controls */}
        <div
          onPointerDown={handleRightDown}
          onPointerMove={handleRightMove}
          onPointerUp={handleRightUp}
          onPointerCancel={handleRightUp}
          role="button"
          tabIndex={0}
          aria-label="Right click. Hold and drag up or down to resize the buttons."
          className={`relative overflow-hidden rounded-2xl border transition-all duration-75 touch-none cursor-pointer ${
            isResizing
              ? 'bg-amber-500/20 border-amber-400/80 shadow-[inset_0_2px_12px_rgba(251,191,36,0.3)]'
              : isRightPressed
              ? 'bg-slate-800/90 border-slate-500 shadow-[inset_0_2px_12px_rgba(148,163,184,0.3)] scale-[0.99]'
              : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-800/90 hover:border-slate-700/80'
          }`}
        >
          {rightHoldProgress > 0 && (
            <div
              className="absolute inset-0 bg-amber-500/20 pointer-events-none transition-all duration-75"
              style={{
                clipPath: `polygon(0 0, ${rightHoldProgress}% 0, ${rightHoldProgress}% 100%, 0 100%)`,
              }}
            />
          )}
          {/* Subtle center tactile pill indicator, or the live size readout */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {isResizing ? (
              <span className="text-lg font-semibold tabular-nums text-amber-200">
                {Math.round(rightScaleRef.current * 100)}%
              </span>
            ) : (
              <div className="w-8 h-1 rounded-full bg-slate-500 opacity-40" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
