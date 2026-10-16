import React, { useEffect, useRef, useState } from 'react';

interface DarkOutProps {
  active: boolean;
  onExit: () => void;
}

// A finger has to *start* this close to the bottom edge, then travel up this
// far, before it counts as the wake gesture. Requiring the start point keeps a
// stray brush across the middle of a black screen from waking it.
const EDGE_ZONE_PX = 150;
const TRAVEL_PX = 70;

/**
 * Dark-out mode: the panel paints itself pure black so the phone looks off,
 * staying in the foreground (and awake) so the remote link is never dropped.
 * Exit is a deliberate swipe up from the bottom edge, or Escape while testing.
 */
export const DarkOut: React.FC<DarkOutProps> = ({ active, onExit }) => {
  const startYRef = useRef<number | null>(null);
  const [hintVisible, setHintVisible] = useState(true);
  const wakeLockRef = useRef<{ release?: () => Promise<void> } | null>(null);

  // The hint is a courtesy on entry, then fades so the screen is genuinely black.
  useEffect(() => {
    if (!active) return;
    setHintVisible(true);
    const t = window.setTimeout(() => setHintVisible(false), 3500);
    return () => window.clearTimeout(t);
  }, [active]);

  // A black-but-on panel is the whole point: if Android sleeps the screen the
  // websocket stalls, so hold a wake lock while dark-out is up. Best-effort —
  // unsupported or insecure contexts just skip it.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const acquire = async () => {
      try {
        const wl = await (navigator as unknown as {
          wakeLock?: { request?: (type: string) => Promise<{ release?: () => Promise<void> }> };
        }).wakeLock?.request?.('screen');
        if (wl && !cancelled) wakeLockRef.current = wl;
      } catch {
        // No wake lock available; the connection simply behaves as before.
      }
    };

    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void wakeLockRef.current?.release?.().catch?.(() => {});
      wakeLockRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onExit]);

  if (!active) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    const y = e.touches[0].clientY;
    startYRef.current = window.innerHeight - y <= EDGE_ZONE_PX ? y : null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current === null) return;
    if (startYRef.current - e.touches[0].clientY > TRAVEL_PX) {
      startYRef.current = null;
      onExit();
    }
  };

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => {
        startYRef.current = null;
      }}
      onTouchCancel={() => {
        startYRef.current = null;
      }}
      className="fixed inset-0 z-[60] bg-black touch-none select-none"
      aria-label="Dark-out mode. Swipe up from the bottom edge to wake."
    >
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 pb-3 transition-opacity duration-1000 ${
          hintVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span className="text-[11px] text-slate-600">Swipe up to wake</span>
        <span className="w-24 h-1.5 rounded-full bg-slate-700/70" />
      </div>
    </div>
  );
};
