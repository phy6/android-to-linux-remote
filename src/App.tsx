import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, Check, Stethoscope, Wifi, WifiOff } from 'lucide-react';
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
import {
  notificationSupport,
  requestNotificationPermission,
  showConnectionNotice,
  AlertPermission,
} from './services/notifications';
import { SpeechDiagnosticsPanel } from './components/SpeechDiagnosticsPanel';
import { PcmCapture } from './services/audioCapture';

const DEFAULT_SETTINGS: RemoteSettings = {
  sensitivity: 1.2,
  acceleration: 1.25,
  invertScroll: false,
  hapticFeedback: true,
  soundFeedback: true,
  twoFingerRightClick: true,
  tapToClick: true,
  wheelSensitivity: DEFAULT_WHEEL_SPACING,
  tailscaleIp: '',
  tailscalePort: 8080,
  useSimulator: true,
  autoConnect: true,
  holdToTalk: true,
  connectionAlerts: true,
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
  const [pttPhase, setPttPhase] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [pttTranscript, setPttTranscript] = useState<string | null>(null);
  const pttTranscriptTimerRef = useRef<number | null>(null);

  const speech = useSpeechRecognition();

  // Surface speech failures on the deck itself, otherwise a blocked microphone
  // makes push-to-talk fail with no visible reason.
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const clearTranscriptTimer = useCallback(() => {
    if (pttTranscriptTimerRef.current !== null) {
      window.clearTimeout(pttTranscriptTimerRef.current);
      pttTranscriptTimerRef.current = null;
    }
  }, []);

  // The laptop's recogniser is the authority on what was said; showing its
  // text on the phone is the only confirmation available when the phone is
  // being used away from the screen.
  useEffect(() => {
    return linuxClient.onDictationText((heard) => {
      clearTranscriptTimer();
      setPttTranscript(heard);
      setPttPhase('idle');
      pttTranscriptTimerRef.current = window.setTimeout(() => {
        pttTranscriptTimerRef.current = null;
        setPttTranscript(null);
      }, 9000);
    });
  }, [clearTranscriptTimer]);

  const showToast = useCallback((text: string, kind: 'ok' | 'warn' = 'ok') => {
    setToast({ text, kind });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    []
  );
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

  const pttSendTimerRef = useRef<number | null>(null);
  const pttTokenRef = useRef(0);
  const captureRef = useRef<PcmCapture | null>(null);
  const daemonPttRef = useRef(false);

  // Push-to-talk: hold the mic to listen, release to type the words into Linux.
  const handlePttStart = useCallback(() => {
    speech.resetTranscript();
    clearTranscriptTimer();
    setPttTranscript(null);
    setPttPhase('listening');
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }

    const token = ++pttTokenRef.current;

    // Prefer the laptop's own offline recogniser: it is already warm, works
    // offline and does not depend on the browser speech engine. Fall back to
    // the browser only when the daemon cannot take the session.
    void linuxClient.startDictation().then(async (ok) => {
      if (pttTokenRef.current !== token) {
        if (ok) linuxClient.stopDictation();
        return;
      }
      if (ok) {
        daemonPttRef.current = true;
        const capture = new PcmCapture({
          onChunk: (pcm) => linuxClient.sendDictationAudio(pcm),
          onError: () => showToast('Microphone unavailable', 'warn'),
        });
        captureRef.current = capture;
        try {
          await capture.start();
        } catch {
          linuxClient.stopDictation();
          daemonPttRef.current = false;
          showSpeechNotice(
            'Microphone blocked. Allow it for this site in your browser settings.'
          );
          setIsPttActive(false);
          return;
        }
        if (pttTokenRef.current !== token) {
          capture.stop();
          linuxClient.stopDictation();
          daemonPttRef.current = false;
          return;
        }
        setIsPttActive(true);
        return;
      }

      daemonPttRef.current = false;
      void speech.startListening().then((started) => {
        if (pttTokenRef.current !== token) {
          if (started) speech.abortListening();
          return;
        }
        setIsPttActive(started);
      });
    });
  }, [speech, showToast, showSpeechNotice, clearTranscriptTimer]);

  const handlePttEnd = useCallback(() => {
    // Invalidate any start that is still awaiting permission.
    pttTokenRef.current += 1;
    setIsPttActive(false);

    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }

    // The laptop recognises the audio it already has and types the result
    // itself, so release just has to close the stream.
    if (daemonPttRef.current) {
      daemonPttRef.current = false;
      const capture = captureRef.current;
      captureRef.current = null;
      setPttPhase('transcribing');
      // The offline re-decode runs after release, so give it a window to report
      // back before concluding nothing was heard.
      pttTranscriptTimerRef.current = window.setTimeout(() => {
        pttTranscriptTimerRef.current = null;
        setPttPhase('idle');
        showToast('Nothing heard — hold the mic and speak', 'warn');
      }, 7000);
      // Send a little trailing audio before closing the session.
      window.setTimeout(() => {
        capture?.stop();
        linuxClient.stopDictation();
      }, 120);
      return;
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
  }, [speech, showToast]);

  const handlePttCancel = useCallback(() => {
    pttTokenRef.current += 1;
    setIsPttActive(false);
    clearTranscriptTimer();
    setPttPhase('idle');
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }
    if (daemonPttRef.current) {
      daemonPttRef.current = false;
      captureRef.current?.stop();
      captureRef.current = null;
      linuxClient.stopDictation();
      return;
    }
    speech.abortListening();
    speech.resetTranscript();
  }, [speech, clearTranscriptTimer]);

  useEffect(
    () => () => {
      if (pttSendTimerRef.current !== null) {
        window.clearTimeout(pttSendTimerRef.current);
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

  // Reconnect to the saved host on launch so the deck is usable immediately.
  const didAutoConnectRef = useRef(false);
  useEffect(() => {
    if (didAutoConnectRef.current) return;
    didAutoConnectRef.current = true;
    const host = settings.tailscaleIp?.trim();
    if (!settings.autoConnect || !host) return;
    linuxClient.connect(host);
  }, [settings.autoConnect, settings.tailscaleIp]);

  // Remember whichever host actually answered, so the address is never retyped.
  const persistedHostRef = useRef<string | null>(null);
  useEffect(() => {
    const host = connectionStatus.hostAddress?.trim();
    if (!host || host === persistedHostRef.current) return;
    persistedHostRef.current = host;
    if (host === settings.tailscaleIp) return;
    handleUpdateSettings({ tailscaleIp: host });
  }, [connectionStatus.hostAddress, settings.tailscaleIp]);

  // Announce link state with a real system notification, falling back to an
  // in-app banner when notifications are not permitted.
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const connected = connectionStatus.connected;
    const previous = prevConnectedRef.current;
    prevConnectedRef.current = connected;
    if (previous === null || previous === connected) return;
    if (!settings.connectionAlerts) return;

    const host = connectionStatus.hostAddress || 'the laptop';
    void showConnectionNotice({ connected, host }).then((posted) => {
      if (posted) return;
      showToast(connected ? `Connected to ${host}` : `Disconnected from ${host}`, connected ? 'ok' : 'warn');
    });
  }, [connectionStatus.connected, connectionStatus.hostAddress, settings.connectionAlerts, showToast]);

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
        onOpenDictation={() => setIsDictationOpen(true)}
        isSimulatorActive={showSimulator}
      />

      {/* Full-screen push-to-talk state: the mic button sits under the thumb,
          so the deck itself has to show what is happening. The laptop types
          into its own focused window, which the phone cannot see, so the
          transcript is echoed back here as the only confirmation available. */}
      {(isPttActive || pttPhase === 'transcribing') && (
        <div className="fixed inset-0 z-20 pointer-events-none flex flex-col items-center justify-center">
          <div
            className={`absolute inset-0 ${isPttActive ? 'bg-rose-950/25' : 'bg-slate-950/35'}`}
          />
          <div className="relative flex items-center gap-3 px-5 py-3 rounded-2xl bg-slate-950/85 border border-rose-500/50 shadow-lg shadow-black/60">
            {isPttActive ? (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
                </span>
                <span className="text-sm font-medium text-rose-100">Listening…</span>
              </>
            ) : (
              <>
                <span className="h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                <span className="text-sm font-medium text-sky-100">Transcribing…</span>
              </>
            )}
          </div>
          <p className="relative mt-3 text-[11px] text-rose-200/70">
            {isPttActive ? 'Release to send to your laptop' : 'Typing on your laptop'}
          </p>
        </div>
      )}

      {/* What the laptop actually heard, so a phone-only session is verifiable. */}
      {pttTranscript && (
        <div className="fixed inset-x-0 bottom-4 z-30 px-4 pointer-events-none flex justify-center">
          <button
            type="button"
            onClick={() => {
              clearTranscriptTimer();
              setPttTranscript(null);
            }}
            className="pointer-events-auto max-w-md w-full text-left px-4 py-3 rounded-2xl bg-emerald-950/90 border border-emerald-500/40 shadow-lg shadow-black/60"
          >
            <div className="flex items-center gap-2 mb-1">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                Typed on your laptop
              </span>
            </div>
            <p className="text-sm text-emerald-50 line-clamp-3">{pttTranscript}</p>
          </button>
        </div>
      )}

      {/* Fallback banner when the system notification is unavailable */}
      {toast && (
        <div
          className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 text-xs px-3 py-2 rounded-xl border shadow-lg shadow-black/50 backdrop-blur-sm ${
            toast.kind === 'ok'
              ? 'bg-emerald-950/90 border-emerald-700/70 text-emerald-200'
              : 'bg-amber-950/90 border-amber-700/70 text-amber-200'
          }`}
        >
          {toast.kind === 'ok' ? (
            <Wifi className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>{toast.text}</span>
        </div>
      )}

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
          buildSha={__BUILD_SHA__}
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
        holdToTalk={settings.holdToTalk}
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
