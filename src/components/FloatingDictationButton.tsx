import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CornerDownLeft, Delete, Mic, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useHaptics } from '../hooks/useHaptics';
import type { MediaAction } from '../types';

const LONG_PRESS_MS = 320;

// A press is a press even if the finger rolls. The old 5px threshold made the
// button cancel dictation on the slightest movement, which forced you to look
// at the screen to land it. 22px is about a thumb's natural drift.
const DRAG_CANCEL_PX = 22;

// Hold, then slide up: the mic becomes a radial media fan. The up-slide must
// clear a deliberate threshold so a stray roll never trips it, and there is
// hysteresis on the way back down so brushing the line does not flicker between
// modes. Sliding further out walks the fan from the innermost item outward.
const COMMAND_SLIDE_PX = 56;
const COMMAND_EXIT_PX = 42;
const COMMAND_ITEM_PX = 46;

// The fan's first item is Enter, so the shortest deliberate slide-and-release
// doubles as a quick Enter key. The rest are the media remote.
const FAN: { key: string; label: string; Icon: typeof Mic; action?: MediaAction }[] = [
  { key: 'enter', label: 'Enter', Icon: CornerDownLeft },
  { key: 'mute', label: 'Mute', Icon: VolumeX, action: 'mute' },
  { key: 'playpause', label: 'Play/Pause', Icon: Play, action: 'playpause' },
  { key: 'prev', label: 'Previous', Icon: SkipBack, action: 'prev' },
  { key: 'next', label: 'Next', Icon: SkipForward, action: 'next' },
  { key: 'voldown', label: 'Volume down', Icon: Volume1, action: 'voldown' },
  { key: 'volup', label: 'Volume up', Icon: Volume2, action: 'volup' },
];

interface FloatingDictationButtonProps {
  onTriggerDictation: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  isListening?: boolean;
  isPushToTalkActive?: boolean;
  onPushToTalkStart: () => void;
  onPushToTalkEnd: () => void;
  onPushToTalkCancel?: () => void;
  /** Briefly turns the mic into a Return key after a dictation lands. */
  enterMode?: boolean;
  onEnterKey?: () => void;
  /** Sends Backspace to the laptop while Return mode is showing. */
  onBackspace?: () => void;
  /** Leaves Return mode early without waiting for the timeout. */
  onExitEnterMode?: () => void;
  /** Fires a media command chosen by holding the mic and sliding up. */
  onCommand?: (cmd: MediaAction) => void;
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
  enterMode = false,
  onEnterKey,
  onBackspace,
  onExitEnterMode,
  onCommand,
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

  // Slide-up command mode: a second, higher threshold turns the hold into a
  // media remote. Mirrored in refs because pointer events can fire faster than
  // React re-renders, so the move/up handlers must not read stale state.
  const [commandMode, setCommandMode] = useState(false);
  const [commandIdx, setCommandIdx] = useState(0);
  const commandModeRef = useRef(false);
  const commandIdxRef = useRef(0);

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
    commandModeRef.current = false;
    commandIdxRef.current = 0;
    setCommandMode(false);
    setCommandIdx(0);
    setIsPressing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Start talking the instant a finger lands. Waiting for a hold threshold
    // made a normal press fall through to the dictation sheet instead, which is
    // exactly the behaviour this button is meant to avoid. In Return mode the
    // press is a tap, so it must not open a dictation session.
    if (!enterMode && !dragRef.current.hasMoved) {
      pttEngagedRef.current = true;
      triggerDictationEngaged();
      onPushToTalkStart();
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // A near-vertical upward move is the command gesture, never a reposition.
    const upSlide = dy < 0 && -dy > Math.abs(dx);

    if (commandModeRef.current) {
      // Slid back toward the button: leave command mode without firing.
      if (dy > -COMMAND_EXIT_PX) {
        commandModeRef.current = false;
        commandIdxRef.current = 0;
        setCommandMode(false);
        setCommandIdx(0);
        return;
      }
      const depth = -dy - COMMAND_SLIDE_PX;
      const idx = Math.min(
        FAN.length - 1,
        Math.max(0, Math.floor(depth / COMMAND_ITEM_PX)),
      );
      if (idx !== commandIdxRef.current) {
        commandIdxRef.current = idx;
        setCommandIdx(idx);
        triggerClick();
      }
      return;
    }

    // Enter command mode and abort the dictation session, so nothing spoken is
    // ever sent while the user is choosing a command.
    if (!enterMode && !dragRef.current.hasMoved && upSlide && -dy >= COMMAND_SLIDE_PX) {
      commandModeRef.current = true;
      commandIdxRef.current = 0;
      setCommandMode(true);
      setCommandIdx(0);
      if (pttEngagedRef.current) {
        pttEngagedRef.current = false;
        onPushToTalkCancel?.();
      }
      triggerDictationEngaged();
      return;
    }

    if (Math.hypot(dx, dy) > DRAG_CANCEL_PX) {
      // Movement cancels push-to-talk so dragging never starts dictation.
      if (pttEngagedRef.current) {
        pttEngagedRef.current = false;
        onPushToTalkCancel?.();
      }
      clearLongPressTimer();
      // The upward slide is reserved for commands, so it cancels the session
      // without ever moving the button.
      if (upSlide) return;
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

    if (commandModeRef.current) {
      // Release fires the highlighted fan item; the dictation session was
      // already cancelled when command mode was entered.
      const item = FAN[commandIdxRef.current];
      triggerClick();
      if (item.action) onCommand?.(item.action);
      else onEnterKey?.();
      commandModeRef.current = false;
      commandIdxRef.current = 0;
      setCommandMode(false);
      setCommandIdx(0);
      setIsPressing(false);
      setIsDragging(false);
      dragRef.current = null;
      pttEngagedRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      return;
    }

    if (dragRef.current.hasMoved) {
      // Saved dragged position
      localStorage.setItem('taildeck_floating_mic_pos', JSON.stringify(pos));
      triggerClick();
    } else if (enterMode) {
      // A tap on the Return key submits, then the mic comes straight back.
      triggerClick();
      onEnterKey?.();
    } else if (pttEngagedRef.current) {
      // Release ends the push-to-talk session and types what was spoken.
      onPushToTalkEnd();
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
    commandModeRef.current = false;
    commandIdxRef.current = 0;
    setCommandMode(false);
    setCommandIdx(0);
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
    <>
      {/* Radial command fan, laid out around the mic and opening toward the
          screen centre, so the items never end up under the thumb or off the
          edge wherever the mic has been parked. */}
      {commandMode && (() => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
        const cx = (pos.x / 100) * vw;
        const cy = (pos.y / 100) * vh;
        const base = Math.atan2(vh / 2 - cy, vw / 2 - cx);
        const n = FAN.length;
        const step = (24 * Math.PI) / 180;
        const radius = Math.max(96, Math.min(vw, vh) * 0.34);
        const margin = 62;
        const clamp = (v: number, lo: number, hi: number) =>
          Math.max(lo, Math.min(hi, v));
        return (
          <div className="fixed inset-0 z-40 pointer-events-none">
            {FAN.map((item, i) => {
              const angle = base + (i - (n - 1) / 2) * step;
              const x = clamp(cx + radius * Math.cos(angle), margin, vw - margin);
              const y = clamp(cy + radius * Math.sin(angle), margin, vh - margin);
              const selected = i === commandIdx;
              return (
                <div
                  key={item.key}
                  style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -50%)' }}
                  className={`absolute flex items-center gap-1.5 rounded-full px-3 py-1.5 border text-xs font-medium transition-all ${
                    selected
                      ? 'bg-indigo-500 border-indigo-300 text-white scale-110 shadow-[0_4px_16px_rgba(79,70,229,0.6)]'
                      : 'bg-slate-900/85 border-slate-700/70 text-slate-300'
                  }`}
                >
                  <item.Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
              );
            })}
          </div>
        );
      })()}

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
        {enterMode && (
          <>
            <button
              type="button"
              onClick={() => {
                triggerClick();
                onBackspace?.();
              }}
              aria-label="Send Backspace"
              style={{
                width: 'calc(68px * var(--td-scale, 1))',
                height: 'calc(68px * var(--td-scale, 1))',
              }}
              className="absolute right-full top-1/2 -translate-y-1/2 mr-3 rounded-full flex items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-700/80 text-sky-300 shadow-[0_6px_20px_rgba(0,0,0,0.6)] hover:border-slate-600 hover:text-sky-200 active:scale-95 transition"
            >
              <Delete className="w-7 h-7" />
            </button>
            <button
              type="button"
              onClick={() => {
                triggerClick();
                onExitEnterMode?.();
              }}
              aria-label="Exit Return mode"
              className="absolute left-1/2 bottom-full mb-3 -translate-x-1/2 rounded-full w-8 h-8 flex items-center justify-center bg-slate-900/90 border border-slate-700/80 text-slate-300 shadow-[0_4px_14px_rgba(0,0,0,0.6)] hover:border-slate-600 hover:text-white active:scale-95 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Simple floating circular button with microphone icon */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          role="button"
          tabIndex={0}
          aria-label={enterMode ? 'Send Return key' : isPttLabel}
          style={{ width: 'calc(104px * var(--td-scale, 1))', height: 'calc(104px * var(--td-scale, 1))' }}
          className={`relative rounded-full flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.6)] border transition-all ${
            isPressing ? 'scale-95' : ''
          } ${
            commandMode
              ? 'bg-gradient-to-b from-indigo-600 to-indigo-700 border-indigo-300 text-white shadow-indigo-500/50'
              : enterMode
                ? 'bg-gradient-to-tr from-emerald-600 to-teal-500 border-emerald-300 text-white shadow-emerald-500/50 animate-pulse'
                : active
                  ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/50'
                  : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-700/80 text-sky-300 shadow-black/60 hover:border-slate-600 hover:text-sky-200'
          }`}
        >
          {/* Pulsing halo while the push-to-talk session is live */}
          {(active || commandMode) && !enterMode && (
            <span
              className={`absolute -inset-3 rounded-full border-2 animate-ping pointer-events-none ${
                commandMode ? 'border-indigo-400/60' : 'border-rose-500/60'
              }`}
            />
          )}

          {enterMode ? (
            <CornerDownLeft className="w-11 h-11" />
          ) : (
            <Mic className={`w-11 h-11 ${active ? 'animate-bounce' : ''}`} />
          )}
        </div>

        {/* Hold hint while pressing; in Return mode it explains the swap */}
        {isPressing && !enterMode && !commandMode && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-sky-200/90 bg-slate-900/90 border border-sky-500/30 rounded-full px-2 py-0.5 pointer-events-none">
            Listening · slide up for commands
          </span>
        )}
        {enterMode && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-emerald-100 bg-emerald-950/90 border border-emerald-400/40 rounded-full px-2 py-0.5 pointer-events-none">
            Tap: Return · × to exit
          </span>
        )}
        {commandMode && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-indigo-100 bg-indigo-950/90 border border-indigo-400/40 rounded-full px-2 py-0.5 pointer-events-none">
            Slide out to choose · release to fire
          </span>
        )}
      </div>
    </>
  );
};