import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic } from 'lucide-react';
import { useHaptics } from '../hooks/useHaptics';

const LONG_PRESS_MS = 320;

// A press is a press even if the finger rolls. The old 5px threshold made the
// button cancel dictation on the slightest movement, which forced you to look
// at the screen to land it. 22px is about a thumb's natural drift.
const DRAG_CANCEL_PX = 22;

interface FloatingDictationButtonProps {
  onTriggerDictation: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  isListening?: boolean;
  isPushToTalkActive?: boolean;
  onPushToTalkStart: () => void;
  onPushToTalkEnd: () => void;
  onPushToTalkCancel?: () => void;
}

export const FloatingDictationButton: React.FC<FloatingDictationButtonProps> = ({
  onTriggerDictation,
  hapticsEnabled,
  soundEnabled,
  isListening = false,
  isPushToTalkActive = false,
  onPushToTalkStart,
  onPushToTalkEnd,
  onPushToTalkCancel,
}) => {
  const { triggerClick, triggerDictationEngaged } = useHaptics(hapticsEnabled, soundEnabled);

  // Position stored in percentage of viewport (default: centered near bottom thumb zone)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('taildeck_floating_mic_pos');
      return saved ? JSON.parse(saved) : { x: 50, y: 72 };
    } catch {
      return { x: 50, y: 72 };
    }
  });

  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const isPttLabel = 'Push to talk. Release to send.';
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialPercentX: number;
    initialPercentY: number;
    hasMoved: boolean;
  } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const pttEngagedRef = useRef(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialPercentX: pos.x,
      initialPercentY: pos.y,
      hasMoved: false,
    };
    pttEngagedRef.current = false;
    setIsPressing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Start talking the instant a finger lands. Waiting for a hold threshold
    // made a normal press fall through to the dictation sheet instead, which is
    // exactly the behaviour this button is meant to avoid.
    if (!dragRef.current.hasMoved) {
      pttEngagedRef.current = true;
      triggerDictationEngaged();
      onPushToTalkStart();
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (Math.hypot(dx, dy) > DRAG_CANCEL_PX) {
      // Movement cancels push-to-talk so dragging never starts dictation.
      if (pttEngagedRef.current) {
        pttEngagedRef.current = false;
        onPushToTalkCancel?.();
      }
      clearLongPressTimer();
      dragRef.current.hasMoved = true;
      setIsDragging(true);

      const winW = window.innerWidth || 360;
      const winH = window.innerHeight || 640;

      const deltaXPercent = (dx / winW) * 100;
      const deltaYPercent = (dy / winH) * 100;

      // Restrict within 8% to 92% screen margins
      const newX = Math.max(8, Math.min(92, dragRef.current.initialPercentX + deltaXPercent));
      const newY = Math.max(8, Math.min(92, dragRef.current.initialPercentY + deltaYPercent));

      setPos({ x: newX, y: newY });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    clearLongPressTimer();

    if (pttEngagedRef.current) {
      // Release ends the push-to-talk session and types what was spoken.
      onPushToTalkEnd();
    } else if (dragRef.current.hasMoved) {
      // Saved dragged position
      localStorage.setItem('taildeck_floating_mic_pos', JSON.stringify(pos));
      triggerClick();
    }

    setIsPressing(false);
    setIsDragging(false);
    dragRef.current = null;
    pttEngagedRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    if (pttEngagedRef.current) {
      pttEngagedRef.current = false;
      onPushToTalkCancel?.();
    }
    clearLongPressTimer();
    setIsPressing(false);
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const active = isPushToTalkActive || isListening;

  return (
    <div
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: 'translate(-50%, -50%)',
      }}
      className={`fixed z-30 select-none touch-none transition-transform duration-75 ${
        isDragging ? 'scale-110 cursor-grabbing' : 'scale-100 cursor-grab'
      }`}
    >
      {/* Simple floating circular button with microphone icon */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        role="button"
        tabIndex={0}
        aria-label={isPttLabel}
        className={`relative w-[104px] h-[104px] rounded-full flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.6)] border transition-all ${
          isPressing ? 'scale-95' : ''
        } ${
          active
            ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/50'
            : 'bg-gradient-to-tr from-sky-600 to-blue-500 border-sky-400/60 text-white shadow-sky-600/30 hover:from-sky-500 hover:to-blue-400'
        }`}
      >
        {/* Pulsing halo while the push-to-talk session is live */}
        {active && (
          <span className="absolute -inset-3 rounded-full border-2 border-rose-500/60 animate-ping pointer-events-none" />
        )}

        <Mic className={`w-11 h-11 ${active ? 'animate-bounce' : ''}`} />
      </div>

      {/* Hold hint, only while pressing so it never clutters the deck */}
      {isPressing && (
        <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-sky-200/90 bg-slate-900/90 border border-sky-500/30 rounded-full px-2 py-0.5 pointer-events-none">
          Listening
        </span>
      )}
    </div>
  );
};