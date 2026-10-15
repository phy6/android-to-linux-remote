import React, { useState, useRef, useEffect } from 'react';
import { Mic } from 'lucide-react';
import { useHaptics } from '../hooks/useHaptics';

interface FloatingDictationButtonProps {
  onTriggerDictation: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  isListening?: boolean;
}

export const FloatingDictationButton: React.FC<FloatingDictationButtonProps> = ({
  onTriggerDictation,
  hapticsEnabled,
  soundEnabled,
  isListening = false,
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
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialPercentX: number;
    initialPercentY: number;
    hasMoved: boolean;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialPercentX: pos.x,
      initialPercentY: pos.y,
      hasMoved: false,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (Math.hypot(dx, dy) > 5) {
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

    if (dragRef.current.hasMoved) {
      // Saved dragged position
      localStorage.setItem('taildeck_floating_mic_pos', JSON.stringify(pos));
      triggerClick();
    } else {
      // Clean tap -> open dictation!
      triggerDictationEngaged();
      onTriggerDictation();
    }

    setIsDragging(false);
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

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
        onPointerCancel={handlePointerUp}
        role="button"
        tabIndex={0}
        aria-label="Dictation Microphone"
        className={`relative w-14 h-14 rounded-full flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.6)] border transition-all active:scale-95 ${
          isListening
            ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/50'
            : 'bg-gradient-to-tr from-sky-600 to-blue-500 border-sky-400/60 text-white shadow-sky-600/30 hover:from-sky-500 hover:to-blue-400'
        }`}
      >
        {/* Subtle pulsing halo when listening */}
        {isListening && (
          <span className="absolute -inset-2 rounded-full border-2 border-rose-500/60 animate-ping pointer-events-none" />
        )}

        <Mic className={`w-6 h-6 ${isListening ? 'animate-bounce' : ''}`} />
      </div>
    </div>
  );
};
