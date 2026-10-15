import { useCallback, useRef } from 'react';

export function useHaptics(enabled: boolean = true, soundEnabled: boolean = true) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const getAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        audioCtxRef.current = new AudioCtx();
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const playClickSound = useCallback((frequency = 800, duration = 0.015, volume = 0.08) => {
    if (!soundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      // Audio autoplay policy fallback
    }
  }, [getAudioContext, soundEnabled]);

  const triggerClick = useCallback(() => {
    if (enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(12);
      } catch {
        // Ignore vibration errors
      }
    }
    playClickSound(850, 0.015, 0.08);
  }, [enabled, playClickSound]);

  const triggerHeavyClick = useCallback(() => {
    if (enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([25, 10, 15]);
      } catch {
        // Ignore vibration errors
      }
    }
    playClickSound(600, 0.03, 0.12);
  }, [enabled, playClickSound]);

  const triggerWheelTick = useCallback(() => {
    if (enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // Ignore vibration errors
      }
    }
    playClickSound(1200, 0.008, 0.04);
  }, [enabled, playClickSound]);

  const triggerDictationEngaged = useCallback(() => {
    if (enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([40, 30, 60]);
      } catch {
        // Ignore vibration errors
      }
    }
    playClickSound(520, 0.06, 0.15);
  }, [enabled, playClickSound]);

  return {
    triggerClick,
    triggerHeavyClick,
    triggerWheelTick,
    triggerDictationEngaged,
  };
}
