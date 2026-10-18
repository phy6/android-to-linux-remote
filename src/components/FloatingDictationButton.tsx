import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CornerDownLeft, Delete, Mic, Play, Repeat2, SkipBack, SkipForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useHaptics } from '../hooks/useHaptics';
import type { MediaAction } from '../types';
import { AppShortcutPanel } from './AppShortcutPanel';

const LONG_PRESS_MS = 320;

// A press is a press even if the finger rolls. The old 5px threshold made the
// button cancel dictation on the slightest movement, which forced you to look
// at the screen to land it. 22px is about a thumb's natural drift.
const DRAG_CANCEL_PX = 22;

// Hold, then slide up: opens a sticky cluster of commands. Slide left instead
// for the apps pinned on the phone. Each slide must clear a deliberate
// threshold so a stray roll never opens a panel.
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
  { key: 'yt_replay', label: 'Replay', Icon: Repeat2, action: 'yt_replay' },
  { key: 'yt_playpause', label: 'YT Play', Icon: Play, action: 'yt_playpause' },
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
  /** host:port of the connected laptop, used to list and launch its apps. */
  host?: string;
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
  host = '',
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

  // Slide-up command cluster, and the slide-left shortcut panel. Both stay open
  // after the finger lifts so a target can be tapped at leisure; tapping the
  // mic/backdrop closes whichever is showing. Mirrored in a ref because pointer
  // events can fire faster than React re-renders.
  const [openPanel, setOpenPanel] = useState<null | 'commands' | 'apps'>(null);
  const openPanelRef = useRef<null | 'commands' | 'apps'>(null);
  const menuOpen = openPanel === 'commands';

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // The mic anchors both panels, so a tap on the mic is the way out — there is
    // no little × to hunt for.
    if (openPanelRef.current) {
      closeMenu();
      return;
    }
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
    if (openPanelRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // Near-vertical up is the command gesture, near-horizontal left is the
    // shortcut panel. Both are deliberate slides, never a reposition.
    const upSlide = dy < 0 && -dy > Math.abs(dx);
    const leftSlide = dx < 0 && -dx > Math.abs(dy);

    const opened = !enterMode && !dragRef.current.hasMoved;
    const wants = opened && ((upSlide && -dy >= COMMAND_SLIDE_PX) ? 'commands'
      : (leftSlide && -dx >= COMMAND_SLIDE_PX) ? 'apps'
      : null);

    // Open the sticky panel and abort the dictation session, so nothing spoken
    // is ever sent while the user is choosing a command or an app.
    if (wants) {
      dragRef.current.hasMoved = true;
      openPanelRef.current = wants;
      setOpenPanel(wants);
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
      // Both slides are reserved for their panels, so they cancel the session
      // without ever moving the button.
      if (upSlide || leftSlide) return;
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

    if (openPanelRef.current) {
      // The panel stays open after the finger lifts; the user taps an item next.
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
    openPanelRef.current = null;
    setOpenPanel(null);
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
    openPanelRef.current = null;
    setOpenPanel(null);
  }, []);

  const openCommands = useCallback(() => {
    openPanelRef.current = 'commands';
    setOpenPanel('commands');
  }, []);

  const openApps = useCallback(() => {
    openPanelRef.current = 'apps';
    setOpenPanel('apps');
  }, []);

  // Firing a command deliberately leaves the menu open, so several commands can
  // be tapped in a row (pause a video, then resume it, then skip). The user
  // closes it by tapping the mic or anywhere outside the cluster.
  const fireItem = (item: (typeof FAN)[number]) => {
    triggerClick();
    if (item.action) onCommand?.(item.action);
    else onEnterKey?.();
  };

  const active = isPushToTalkActive || isListening;

  return (
    <>
      {/* Sticky command cluster: the mic is one corner of it and Enter sits
          right beside the mic, so the most-used key is always the easiest to
          reach; the media buttons fan away from the mic. It stays open until
          the mic or the backdrop is tapped. */}
      {menuOpen && (() => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
        const cx = (pos.x / 100) * vw;
        const cy = (pos.y / 100) * vh;
        const gap = 8;
        const pad = 8;
        const MIC = 104;
        const gridRows = Math.ceil((FAN.length - 1) / 2);
        const micTop = cy - MIC / 2;
        const micBottom = cy + MIC / 2;
        const micLeft = cx - MIC / 2;
        const micRight = cx + MIC / 2;
        // Enter shares the mic's row instead of taking a row of its own, so the
        // media grid starts right at the mic. Size the panel to the mic's side so
        // the mic lands in that row's corner cell, and grow toward mid-screen.
        const enterOnLeft = cx >= vw / 2;
        let panelW = Math.min(340, vw - 2 * pad, enterOnLeft ? micRight : vw - micLeft);
        panelW = Math.max(panelW, pad * 2 + MIC + gap + 88);
        // Rows shrink only as far as needed to stay on screen on a short or
        // landscape viewport. Every button keeps a usable tap height.
        let rowH = 60;
        let gridH = gridRows * rowH + (gridRows - 1) * gap;
        let panelH = pad * 2 + MIC + gap + gridH;
        const maxH = vh - pad * 2;
        if (panelH > maxH) {
          const availGrid = maxH - pad * 2 - MIC - gap;
          rowH = Math.max(36, Math.floor((availGrid - (gridRows - 1) * gap) / gridRows));
          gridH = gridRows * rowH + (gridRows - 1) * gap;
          panelH = pad * 2 + MIC + gap + gridH;
        }
        // Hang the cluster below the mic when it fits, otherwise put it above with
        // the mic's row as its last row. Either way the mic's row stays hard
        // against the mic and the rest fans away from the thumb.
        const below = micTop - pad + panelH <= vh - pad;
        const top = Math.max(
          pad,
          Math.min(vh - panelH - pad, below ? micTop - pad : micBottom + pad - panelH)
        );
        const left = Math.max(
          pad,
          Math.min(vw - panelW - pad, enterOnLeft ? micRight + pad - panelW : micLeft - pad)
        );
        const enterButton = (
          <button
            type="button"
            data-command-item={FAN[0].key}
            onClick={() => fireItem(FAN[0])}
            style={{ height: `${MIC}px` }}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-indigo-400/50 bg-indigo-600/90 text-white text-lg font-semibold hover:bg-indigo-500 active:scale-[0.98] transition"
          >
            <CornerDownLeft className="w-8 h-8 shrink-0" />
            <span>{FAN[0].label}</span>
          </button>
        );
        const micRow = (
          <div className="flex items-center" style={{ gap: `${gap}px` }}>
            {enterOnLeft && enterButton}
            <div className="shrink-0" style={{ width: `${MIC}px`, height: `${MIC}px` }} />
            {!enterOnLeft && enterButton}
          </div>
        );
        const grid = (
          <div className="grid grid-cols-2" style={{ gap: `${gap}px` }}>
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
        );
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={closeMenu} />
            <div
              data-command-menu="true"
              style={{ left: `${left}px`, top: `${top}px`, width: `${panelW}px` }}
              className="fixed z-40 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
            >
              {below ? (
                <div className="flex flex-col" style={{ gap: `${gap}px` }}>
                  {micRow}
                  {grid}
                </div>
              ) : (
                <div className="flex flex-col" style={{ gap: `${gap}px` }}>
                  {grid}
                  {micRow}
                </div>
              )}
            </div>
          </>
        );
      })()}

      {/* Shortcut panel: the apps pinned on the phone, growing sideways away
          from the mic so it never covers the mic or the thumb zone. It is a
          list, so it stays usable even when the mic sits mid-screen and there
          is little room on either side. */}
      {openPanel === 'apps' && (() => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
        const cx = (pos.x / 100) * vw;
        const cy = (pos.y / 100) * vh;
        const pad = 8;
        const gap = 8;
        const MIC = 104;
        const roomLeft = cx - MIC / 2 - gap - pad;
        const roomRight = vw - (cx + MIC / 2) - gap - pad;
        // Open on the roomier side so the panel grows toward the middle of the
        // screen, keeping the mic as the outer edge of the cluster.
        const toLeft = roomLeft >= roomRight;
        const width = Math.max(132, Math.min(260, toLeft ? roomLeft : roomRight));
        const left = Math.max(
          pad,
          Math.min(vw - width - pad, toLeft ? cx - MIC / 2 - gap - width : cx + MIC / 2 + gap),
        );
        const height = Math.min(340, vh - pad * 2);
        const top = Math.max(pad, Math.min(vh - height - pad, cy - MIC / 2));
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={closeMenu} />
            <AppShortcutPanel host={host} anchor={{ left, top, width, height }} />
          </>
        );
      })()}

      <div
        style={{
          left: `${pos.x}%`,
          top: `${pos.y}%`,
          transform: 'translate(-50%, -50%)',
        }}
        className={`fixed select-none touch-none transition-transform duration-75 ${
          openPanel ? 'z-50' : 'z-30'
        } ${
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

        {/* Direction hints: two curved wedges hugging the inside of the mic rim,
            their arcs following the rim and their points aimed at the centre.
            Up opens the commands, left opens the app shortcuts. Each is its own
            target, so the rest of the mic still takes a press. They hide as soon
            as a panel opens, so they never draw over its buttons. */}
        {!enterMode && !active && !openPanel && (
          <svg
            className="pointer-events-none absolute inset-0 z-10 h-full w-full"
            viewBox="0 0 104 104"
            aria-hidden="false"
          >
            <path
              d="M 52 25 Q 52 11 41.604 3.093 A 50 50 0 0 1 62.396 3.093 Q 52 11 52 25 Z"
              role="button"
              tabIndex={0}
              aria-label="Open commands"
              onClick={openCommands}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') openCommands();
              }}
              className="pointer-events-auto cursor-pointer fill-sky-300 transition hover:fill-sky-200 active:fill-sky-100"
            />
            <path
              d="M 25 52 Q 11 52 3.093 62.396 A 50 50 0 0 1 3.093 41.604 Q 11 52 25 52 Z"
              role="button"
              tabIndex={0}
              aria-label="Open app shortcuts"
              onClick={openApps}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') openApps();
              }}
              className="pointer-events-auto cursor-pointer fill-sky-300 transition hover:fill-sky-200 active:fill-sky-100"
            />
          </svg>
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
            openPanel
              ? 'bg-gradient-to-b from-indigo-600 to-indigo-700 border-indigo-300 text-white shadow-indigo-500/50'
              : enterMode
                ? 'bg-gradient-to-tr from-emerald-600 to-teal-500 border-emerald-300 text-white shadow-emerald-500/50 animate-pulse'
                : active
                  ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/50'
                  : 'bg-gradient-to-b from-slate-900 to-slate-950 border-slate-700/80 text-sky-300 shadow-black/60 hover:border-slate-600 hover:text-sky-200'
          }`}
        >
          {/* Pulsing halo only while the push-to-talk session is live. The
              panels are a menu, not a recording, so they get no halo. */}
          {active && !enterMode && (
            <span className="absolute -inset-3 rounded-full border-2 animate-ping pointer-events-none border-rose-500/60" />
          )}

          {enterMode ? (
            <CornerDownLeft className="w-11 h-11" />
          ) : (
            <Mic className={`w-11 h-11 ${active ? 'animate-bounce' : ''}`} />
          )}
        </div>

        {/* Hold hint while pressing; in Return mode it explains the swap */}
        {isPressing && !enterMode && !openPanel && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-sky-200/90 bg-slate-900/90 border border-sky-500/30 rounded-full px-2 py-0.5 pointer-events-none">
            Listening · slide up: keys · left: apps
          </span>
        )}
        {enterMode && (
          <span className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-emerald-100 bg-emerald-950/90 border border-emerald-400/40 rounded-full px-2 py-0.5 pointer-events-none">
            Tap: Return · × to exit
          </span>
        )}
      </div>
    </>
  );
};