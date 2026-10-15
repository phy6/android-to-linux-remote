import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, Stethoscope } from 'lucide-react';
import { linuxClient } from './services/linuxClient';
import { ConnectionStatus, RemoteSettings } from './types';
import {
  HorizontalScrollWheel,
  MIN_WHEEL_SPACING,
  DEFAULT_WHEEL_SPACING,
} from './components/HorizontalScrollWheel';
import { Trackpad } from './components/Trackpad';
import { BottomClickButtons } from './components/BottomClickButtons';
import { FloatingDictationButton } from './components/FloatingDictationButton';
import { DictationModal } from './components/DictationModal';
import { SideMenuDrawer } from './components/SideMenuDrawer';
import { LinuxSimulator } from './components/LinuxSimulator';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { SpeechDiagnosticsPanel } from './components/SpeechDiagnosticsPanel';

const DEFAULT_SETTINGS: RemoteSettings = {
  sensitivity: 1.2,
  acceleration: 1.25,
  invertScroll: false,
  hapticFeedback: true,
  soundFeedback: true,
  twoFingerRightClick: true,
  tapToClick: true,
  wheelSensitivity: DEFAULT_WHEEL_SPACING,
  tailscaleIp: '192.0.2.10:8080',
  tailscalePort: 8080,
  useSimulator: true,
};

export default function App() {
  const [settings, setSettings] = useState<RemoteSettings>(() => {
    try {
      const saved = localStorage.getItem('taildeck_settings');
      if (!saved) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(saved) as Partial<RemoteSettings>;
      // Older builds persisted a far tighter notches-per-pixel value, which
      // made one swipe cycle every open app. Snap stale values to the default.
      const wheelSensitivity =
        typeof parsed.wheelSensitivity === 'number' &&
        parsed.wheelSensitivity >= MIN_WHEEL_SPACING
          ? parsed.wheelSensitivity
          : DEFAULT_WHEEL_SPACING;
      return { ...DEFAULT_SETTINGS, ...parsed, wheelSensitivity };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(linuxClient.getStatus());
  const [activeAppIndex, setActiveAppIndex] = useState(0);

  // Side Drawer & Modals
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isDictationOpen, setIsDictationOpen] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [isPttActive, setIsPttActive] = useState(false);

  const speech = useSpeechRecognition();
  const pttSendTimerRef = useRef<number | null>(null);
  const pttTokenRef = useRef(0);

  // Push-to-talk: hold the mic to listen, release to type the words into Linux.
  const handlePttStart = useCallback(() => {
    speech.resetTranscript();
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }

    const token = ++pttTokenRef.current;
    void speech.startListening().then((started) => {
      // The finger may already be lifted by the time permission resolves.
      if (pttTokenRef.current !== token) {
        if (started) speech.abortListening();
        return;
      }
      setIsPttActive(started);
    });
  }, [speech]);

  const handlePttEnd = useCallback(() => {
    // Invalidate any start that is still awaiting permission.
    pttTokenRef.current += 1;
    setIsPttActive(false);

    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }

    speech.stopListening();
    if (!speech.transcriptRef.current.trim()) return;

    // Give the engine a beat to deliver its final result before reading the text.
    pttSendTimerRef.current = window.setTimeout(() => {
      pttSendTimerRef.current = null;
      const text = speech.transcriptRef.current.trim();
      if (!text) return;
      linuxClient.sendTypeText(text);
      linuxClient.sendKeyCombo(['Return']);
      speech.resetTranscript();
    }, 350);
  }, [speech]);

  const handlePttCancel = useCallback(() => {
    pttTokenRef.current += 1;
    setIsPttActive(false);
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }
    speech.abortListening();
    speech.resetTranscript();
  }, [speech]);

  useEffect(
    () => () => {
      if (pttSendTimerRef.current !== null) {
        window.clearTimeout(pttSendTimerRef.current);
      }
    },
    []
  );

  // Surface speech failures on the deck itself, otherwise a blocked microphone
  // makes push-to-talk fail with no visible reason.
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const noticeTimerRef = useRef<number | null>(null);

  const showSpeechNotice = useCallback((message: string) => {
    setSpeechNotice(message);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => setSpeechNotice(null), 6000);
  }, []);

  useEffect(() => {
    if (speech.error) showSpeechNotice(speech.error);
  }, [speech.error, showSpeechNotice]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    },
    []
  );

  const handleUpdateSettings = (newSettings: Partial<RemoteSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      try {
        localStorage.setItem('taildeck_settings', JSON.stringify(updated));
      } catch {
        // Ignore
      }
      return updated;
    });
  };

  useEffect(() => {
    const unsub = linuxClient.subscribeStatus((status) => {
      setConnectionStatus(status);
    });
    return unsub;
  }, []);

  const handleAppSwitch = (direction: 'prev' | 'next') => {
    setActiveAppIndex((prev) => {
      return direction === 'next' ? (prev + 1) % 6 : (prev - 1 + 6) % 6;
    });
  };

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-slate-950 text-slate-100 font-sans select-none overflow-hidden touch-none relative">
      {/* Main Remote Deck (Clean, Unmarked, Edge-to-Edge) */}
      <main className="flex-1 flex flex-col h-full w-full bg-slate-950">
        {/* Top: Unmarked Minimal Horizontal Scroll Wheel (left = Shift+Tab, right = Tab) */}
        <div className="shrink-0 z-10">
          <HorizontalScrollWheel
            hapticsEnabled={settings.hapticFeedback}
            soundEnabled={settings.soundFeedback}
            sensitivity={settings.wheelSensitivity}
            onAppSwitch={handleAppSwitch}
          />
        </div>

        {/* 3/5 Screen: Pure Unmarked Glass Trackpad */}
        <div className="flex-1 relative min-h-0 flex flex-col">
          <Trackpad
            sensitivity={settings.sensitivity}
            acceleration={settings.acceleration}
            invertScroll={settings.invertScroll}
            tapToClick={settings.tapToClick}
            twoFingerRightClick={settings.twoFingerRightClick}
            hapticsEnabled={settings.hapticFeedback}
            soundEnabled={settings.soundFeedback}
          />
        </div>

        {/* Bottom: 2 Unmarked Tactile Click Buttons */}
        <div className="shrink-0 z-10">
          <BottomClickButtons
            hapticsEnabled={settings.hapticFeedback}
            soundEnabled={settings.soundFeedback}
            onTriggerDictation={() => setIsDictationOpen(true)}
          />
        </div>
      </main>

      {/* Slide-In Full Menu Drawer (Drag in from side or tap left edge handle) */}
      <SideMenuDrawer
        isOpen={isDrawerOpen}
        onOpen={() => setIsDrawerOpen(true)}
        onClose={() => setIsDrawerOpen(false)}
        connectionStatus={connectionStatus}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onToggleSimulator={() => setShowSimulator((prev) => !prev)}
        isSimulatorActive={showSimulator}
      />

      {/* Speech failure notice so a blocked mic is never silent */}
      {speechNotice && (
        <button
          onClick={() => setSpeechNotice(null)}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-40 max-w-[90vw] flex items-start gap-2 text-left text-xs px-3 py-2 rounded-xl bg-amber-950/90 border border-amber-700/70 text-amber-200 shadow-lg shadow-black/50 backdrop-blur-sm"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{speechNotice}</span>
        </button>
      )}

      {/* Diagnostics trigger so a failing dictation can be inspected on device */}
      <button
        onClick={() => setShowDiagnostics(true)}
        className="fixed top-3 right-3 z-30 p-2 rounded-xl bg-slate-900/80 border border-slate-700/70 text-slate-400 hover:text-sky-300 active:scale-95"
        title="Dictation diagnostics"
        aria-label="Dictation diagnostics"
      >
        <Stethoscope className="w-4 h-4" />
      </button>

      {showDiagnostics && (
        <SpeechDiagnosticsPanel
          diagnostics={speech.diagnostics}
          error={speech.error}
          permission={speech.permission}
          onClose={() => setShowDiagnostics(false)}
        />
      )}

      {/* Floating Mic: hold to talk (push-to-talk), tap for the dictation sheet, drag to move */}
      <FloatingDictationButton
        onTriggerDictation={() => setIsDictationOpen(true)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
        isPushToTalkActive={isPttActive}
        onPushToTalkStart={handlePttStart}
        onPushToTalkEnd={handlePttEnd}
        onPushToTalkCancel={handlePttCancel}
      />

      {/* Voice Dictation Input Sheet */}
      <DictationModal
        isOpen={isDictationOpen}
        onClose={() => setIsDictationOpen(false)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
        speech={speech}
      />

      {/* Embedded Linux Desktop Simulator (If opened from side menu) */}
      {showSimulator && (
        <div className="fixed inset-0 z-40 bg-black/80 backdrop-blur-md p-3 sm:p-6 flex flex-col animate-fadeIn">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-white">
              Live Linux Desktop Preview (Wayland & X11)
            </span>
            <button
              onClick={() => setShowSimulator(false)}
              className="text-xs px-3 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
            >
              Close Preview
            </button>
          </div>
          <div className="flex-1 rounded-2xl overflow-hidden border border-slate-700">
            <LinuxSimulator
              activeAppIndex={activeAppIndex}
              onAppSwitch={handleAppSwitch}
              onClose={() => setShowSimulator(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
