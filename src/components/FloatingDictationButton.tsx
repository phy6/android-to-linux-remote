import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CornerDownLeft, Delete, Mic, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useHaptics } from '../hooks/useHaptics';
import type { MediaAction } from '../types';

const LONG_PRESS_MS = 320;

// A press is a press even if the finger rolls. The old 5px threshold made the
// button cancel dictation on the slightest movement, which forced you to look
// at the screen to land it. 22px is about a thumb's natural drift.
const DRAG_CANCEL_PX = 22;

// Hold, then slide up: opens a sticky radial menu of commands. The slide must
// clear a deliberate threshold so a stray roll never opens it.
const COMMAND_SLIDE_PX = 56;

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

  // Slide-up command menu: a higher threshold opens a sticky fan of commands.
  // It stays open after the finger lifts so the user can tap a big target at
  // leisure; tapping the backdrop or the x closes it. Mirrored in a ref because
  // pointer events can fire faster than React re-renders.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);

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
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore: the pointer may already be gone (e.g. synthetic events).
    }

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
    if (menuOpenRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // A near-vertical upward move is the command gesture, never a reposition.
    const upSlide = dy < 0 && -dy > Math.abs(dx);

    // Open the sticky command menu and abort the dictation session, so nothing
    // spoken is ever sent while the user is choosing a command.
    if (!enterMode && !dragRef.current.hasMoved && upSlide && -dy >= COMMAND_SLIDE_PX) {
      dragRef.current.hasMoved = true;
      menuOpenRef.current = true;
      setMenuOpen(true);
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

    if (menuOpenRef.current) {
      // The menu stays open after the finger lifts; the user taps an item next.
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
    menuOpenRef.current = false;
    setMenuOpen(false);
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

  const closeMenu = useCallback(() => {
    menuOpenRef.current = false;
    setMenuOpen(false);
  }, []);

  // Firing a command deliberately leaves the menu open, so several commands can
  // be tapped in a row (pause a video, then resume it, then skip). The user
  // closes it with the x or by tapping the backdrop.
  const fireItem = (item: (typeof FAN)[number]) => {
    triggerClick();
    if (item.action) onCommand?.(item.action);
    else onEnterKey?.();
  };

  const active = isPushToTalkActive || isListening;

  return (
    <>
      {/* Sticky command panel: a big, overlap-free grid anchored to the mic. It
          stays open until an item is tapped; tapping the backdrop dismisses it. */}
      {menuOpen && (() => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
        const cx = (pos.x / 100) * vw;
        const cy = (pos.y / 100) * vh;
        const gap = 8;
        const pad = 8;
        const rowH = 56;
        const headerH = 28;
        const panelW = Math.min(vw - 2 * pad, 340);
        const panelH = pad * 2 + headerH + gap + rowH + gap + 3 * rowH + 2 * gap;
        const left = Math.max(pad, Math.min(vw - panelW - pad, cx - panelW / 2));
        let top = cy - 52 - 12 - panelH;
        if (top < pad) top = Math.min(vh - panelH - pad, cy + 52 + 12);
        top = Math.max(pad, top);
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={closeMenu} />
            <div
              data-command-menu="true"
              style={{ left: `${left}px`, top: `${top}px`, width: `${panelW}px` }}
              className="fixed z-40 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
            >
              <div className="flex items-center justify-between" style={{ height: `${headerH}px` }}>
                <span className="pl-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Commands
                </span>
                <button
                  type="button"
                  aria-label="Close command menu"
                  onClick={closeMenu}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-700 hover:text-white active:scale-95 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {(() => {
                const first = FAN[0];
                return (
                  <button
                    type="button"
                    data-command-item={first.key}
                    onClick={() => fireItem(first)}
                    style={{ height: `${rowH}px` }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-indigo-400/50 bg-indigo-600/90 text-white text-base font-semibold hover:bg-indigo-500 active:scale-[0.98] transition"
                  >
                    <first.Icon className="w-5 h-5 shrink-0" />
                    <span>{first.label}</span>
                  </button>
                );
              })()}
              <div className="grid grid-cols-2" style={{ gap: `${gap}px`, marginTop: `${gap}px` }}>
                {FAN.slice(1).map(item => (
                  <button
                    key={item.key}
                    type="button"
                    data-command-item={item.key}
                    onClick={() => fireItem(item)}
                    style={{ height: `${rowH}px` }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-slate-700/80 bg-slate-800/90 text-slate-100 text-sm font-semibold px-2 hover:border-indigo-400 hover:bg-slate-700 active:scale-[0.98] transition"
                  >
                    <item.Icon className="w-5 h-5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
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
            menuOpen
              ? 'bg-gradient-to-b from-indigo-600 to-indigo-700 border-indigo-300 text-white shadow-indigo-500/50'
              : enterMode
                ? 'bg-gradient-to-tr from-emerald-600 to-teal-500 border-emerald-300 text-white shadow-emerald-500/50 animate-pulse'
                : active
                  ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/50'
                  : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-700/80 text-sky-300 shadow-black/60 hover:border-slate-600 hover:text-sky-200'
          }`}
        >
          {/* Pulsing halo while the push-to-talk session is live */}
          {(active || menuOpen) && !enterMode && (
            <span
              className={`absolute -inset-3 rounded-full border-2 animate-ping pointer-events-none ${
                menuOpen ? 'border-indigo-400/60' : 'border-rose-500/60'
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
        {isPressing && !enterMode && !menuOpen && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-sky-200/90 bg-slate-900/90 border border-sky-500/30 rounded-full px-2 py-0.5 pointer-events-none">
            Listening · slide up for commands
          </span>
        )}
        {enterMode && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-emerald-100 bg-emerald-950/90 border border-emerald-400/40 rounded-full px-2 py-0.5 pointer-events-none">
            Tap: Return · × to exit
          </span>
        )}
        {menuOpen && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-indigo-100 bg-indigo-950/90 border border-indigo-400/40 rounded-full px-2 py-0.5 pointer-events-none">
            Tap a command · tap away to close
          </span>
        )}
      </div>
    </>
  );
};