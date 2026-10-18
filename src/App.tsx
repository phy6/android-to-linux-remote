import { useState, useEffect, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { AlertCircle, Check, Wifi, WifiOff } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { linuxClient } from './services/linuxClient';
import { LOCAL_HOST, IS_LOCAL_MODE, describeRoute, servedByLabel } from './services/localMode';
import { rememberLaptop, loadSavedLaptops } from './services/savedLaptops';
import { autoconnectOrder, isTailnetIp } from './services/pairing';
import { ConnectionStatus, RemoteSettings } from './types';
import {
  HorizontalScrollWheel,
  MIN_WHEEL_SPACING,
  DEFAULT_WHEEL_SPACING,
} from './components/HorizontalScrollWheel';
import { Trackpad } from './components/Trackpad';
import {
  BottomClickButtons,
  MIN_BUTTON_SCALE,
  MAX_BUTTON_SCALE,
  DEFAULT_BUTTON_SCALE,
} from './components/BottomClickButtons';
import { FloatingDictationButton } from './components/FloatingDictationButton';
import { DictationModal } from './components/DictationModal';
import { SideMenuDrawer } from './components/SideMenuDrawer';
import { SetupQrScreen } from './components/SetupQrScreen';
import { LinuxSimulator } from './components/LinuxSimulator';
import { DarkOut } from './components/DarkOut';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import {
  notificationSupport,
  requestNotificationPermission,
  showConnectionNotice,
  showMessageNotice,
  AlertPermission,
} from './services/notifications';
import { SpeechDiagnosticsPanel } from './components/SpeechDiagnosticsPanel';
import { PcmCapture, warmMic } from './services/audioCapture';
import { respondToChallenge, webAuthnAvailable } from './services/authClient';

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
  autoConnect: true,
  preferLocal: true,
  connectionAlerts: true,
  buttonScale: DEFAULT_BUTTON_SCALE,
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
      // Keep a hand-edited or stale stored size inside the supported range.
      const buttonScale =
        typeof parsed.buttonScale === 'number'
          ? Math.min(MAX_BUTTON_SCALE, Math.max(MIN_BUTTON_SCALE, parsed.buttonScale))
          : DEFAULT_BUTTON_SCALE;
      return { ...DEFAULT_SETTINGS, ...parsed, wheelSensitivity, buttonScale };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(linuxClient.getStatus());
  const [activeAppIndex, setActiveAppIndex] = useState(0);

  // Live size preview while dragging the resize grip; null means "use the
  // saved setting". Kept separate so a drag never spams localStorage.
  const [buttonScalePreview, setButtonScalePreview] = useState<number | null>(null);
  const effectiveButtonScale = buttonScalePreview ?? settings.buttonScale;

  // Side Drawer & Modals
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'tailscale' | 'keys' | 'media' | 'settings' | 'help' | undefined>();
  const [showSetup, setShowSetup] = useState(false);
  const [isDictationOpen, setIsDictationOpen] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [darkOut, setDarkOut] = useState(false);
  const [isPttActive, setIsPttActive] = useState(false);
  // Mirrors isPttActive for callbacks that must not offer Return/Delete while a
  // hold is still running: the laptop streams live text per phrase, and each of
  // those must not be mistaken for "a dictation just landed".
  const pttActiveRef = useRef(false);
  const [pttPhase, setPttPhase] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  // True from the instant the mic is pressed until capture actually begins, so
  // the "Listening…" indicator appears immediately instead of waiting on the
  // mic open (getUserMedia), which is the slow part on Android.
  const [pttWarming, setPttWarming] = useState(false);
  const [pttTranscript, setPttTranscript] = useState<string | null>(null);
  const [pttPartial, setPttPartial] = useState<string | null>(null);
  const pttTranscriptTimerRef = useRef<number | null>(null);

  const speech = useSpeechRecognition();

  // Register the service worker once, at the root, so an update is noticed even
  // if the drawer is never opened. The Settings tab's Updates card reads this.
  const {
    needRefresh: [appUpdateReady],
    updateServiceWorker,
  } = useRegisterSW();

  const applyAppUpdate = useCallback(async () => {
    if (appUpdateReady) {
      await updateServiceWorker(true);
      return;
    }
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      // Fall through to the reload.
    }
    location.reload();
  }, [appUpdateReady, updateServiceWorker]);

  // Surface speech failures on the deck itself, otherwise a blocked microphone
  // makes push-to-talk fail with no visible reason.
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  // The daemon types a dictation into the focused window but never submits it,
  // so for a few seconds after a session the mic doubles as a Return key.
  const [enterPrompt, setEnterPrompt] = useState(false);
  const enterPromptTimerRef = useRef<number | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const clearTranscriptTimer = useCallback(() => {
    if (pttTranscriptTimerRef.current !== null) {
      window.clearTimeout(pttTranscriptTimerRef.current);
      pttTranscriptTimerRef.current = null;
    }
  }, []);

  // Return/Delete mode stays up for 12s, and every Return/Delete tap re-arms it,
  // so it never times out mid-use (the 5s window used to vanish under the thumb).
  const armEnterPrompt = useCallback((holdMs = 12000) => {
    if (enterPromptTimerRef.current !== null) {
      window.clearTimeout(enterPromptTimerRef.current);
    }
    setEnterPrompt(true);
    enterPromptTimerRef.current = window.setTimeout(() => {
      enterPromptTimerRef.current = null;
      setEnterPrompt(false);
    }, holdMs);
  }, []);

  const exitEnterPrompt = useCallback(() => {
    if (enterPromptTimerRef.current !== null) {
      window.clearTimeout(enterPromptTimerRef.current);
      enterPromptTimerRef.current = null;
    }
    setEnterPrompt(false);
  }, []);

  // The laptop's recogniser is the authority on what was said; showing its
  // text on the phone is the only confirmation available when the phone is
  // being used away from the screen.
  useEffect(() => {
    return linuxClient.onDictationText((heard) => {
      clearTranscriptTimer();
      setPttPartial(null);
      const piece = heard.trim();
      const merged = piece
        ? (pttCommittedRef.current ? `${pttCommittedRef.current} ${piece}` : piece)
        : pttCommittedRef.current;
      pttCommittedRef.current = merged;
      setPttTranscript(merged || null);
      setPttPhase('idle');
      pttTranscriptTimerRef.current = window.setTimeout(() => {
        pttTranscriptTimerRef.current = null;
        setPttTranscript(null);
      }, 9000);
      // Offer Return only when words actually landed *and the hold has ended*.
      // Live per-phrase text arrives mid-hold, and offering Return then flipped
      // the mic (and its Delete key) out from under the user's thumb.
      if (heard.trim() && !pttActiveRef.current && !pttCancelledRef.current) {
        armEnterPrompt();
      }
    });
  }, [clearTranscriptTimer, armEnterPrompt]);

  // Live hypotheses streamed back while still holding the mic. Preview only:
  // the final text replaces them once the laptop finishes its re-decode.
  useEffect(() => {
    return linuxClient.onDictationPartial((text) => {
      setPttPartial(text);
    });
  }, []);

  useEffect(() => {
    pttActiveRef.current = isPttActive || pttWarming;
  }, [isPttActive, pttWarming]);

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
      if (enterPromptTimerRef.current !== null) {
        window.clearTimeout(enterPromptTimerRef.current);
      }
    },
    []
  );

  const pttSendTimerRef = useRef<number | null>(null);
  const pttTokenRef = useRef(0);
  const pttCommittedRef = useRef('');
  // True once a gesture aborted the session (e.g. a slide that opened a command
  // panel). Any transcript that still arrives for it must never arm Return mode.
  const pttCancelledRef = useRef(false);
  const captureRef = useRef<PcmCapture | null>(null);
  const daemonPttRef = useRef(false);

  // Push-to-talk: hold the mic to listen, release to type the words into Linux.
  const handlePttStart = useCallback(() => {
    speech.resetTranscript();
    clearTranscriptTimer();
    setPttTranscript(null);
    setPttPartial(null);
    pttCommittedRef.current = '';
    pttCancelledRef.current = false;
    setPttPhase('listening');
    setPttWarming(true);
    if (enterPromptTimerRef.current !== null) {
      window.clearTimeout(enterPromptTimerRef.current);
      enterPromptTimerRef.current = null;
    }
    setEnterPrompt(false);
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }

    const token = ++pttTokenRef.current;

    // Open the mic and open the laptop session at the same time. The websocket
    // round-trip is short, so overlapping it under getUserMedia — the slow part
    // on Android — keeps the handshake off the critical path. The stream is
    // warm from the previous press, so this is usually just a graph re-wire.
    const capture = new PcmCapture({
      onChunk: (pcm) => linuxClient.sendDictationAudio(pcm),
      onError: () =>
        showToast(
          window.isSecureContext
            ? 'Microphone unavailable'
            : 'Talking needs a secure link: use Setup and open the https :8443 address',
          'warn',
        ),
    });
    let micError: unknown = null;
    const micReady = capture.start().catch((err) => {
      micError = err;
    });
    const sessionReady = linuxClient.startDictation();

    void (async () => {
      // Prefer the laptop's own offline recogniser: it is already warm, works
      // offline and does not depend on the browser speech engine. Fall back to
      // the browser only when the daemon cannot take the session.
      const ok = await sessionReady;

      if (pttTokenRef.current !== token) {
        if (ok) linuxClient.stopDictation();
        capture.stop();
        return;
      }

      if (!ok) {
        // No laptop session: drop the mic we speculatively opened and use the
        // browser's own recogniser instead.
        capture.stop();
        daemonPttRef.current = false;
        void speech.startListening().then((started) => {
          if (pttTokenRef.current !== token) {
            if (started) speech.abortListening();
            return;
          }
          setIsPttActive(started);
          setPttWarming(false);
          if (!started) setPttPhase('idle');
        });
        return;
      }

      daemonPttRef.current = true;
      captureRef.current = capture;
      await micReady;

      if (micError) {
        captureRef.current = null;
        linuxClient.stopDictation();
        daemonPttRef.current = false;
        setPttWarming(false);
        setPttPhase('idle');
        showSpeechNotice(
          window.isSecureContext
            ? 'Microphone blocked. Allow it for this site in your browser settings.'
            : 'Talking needs a secure link. Open Setup, install the certificate, then use the https :8443 address.'
        );
        setIsPttActive(false);
        return;
      }
      if (pttTokenRef.current !== token) {
        captureRef.current = null;
        capture.stop();
        linuxClient.stopDictation();
        daemonPttRef.current = false;
        setPttWarming(false);
        setPttPhase('idle');
        return;
      }
      setPttWarming(false);
      setIsPttActive(true);
    })();
  }, [speech, showToast, showSpeechNotice, clearTranscriptTimer]);

  const handlePttEnd = useCallback(() => {
    // Invalidate any start that is still awaiting permission.
    pttTokenRef.current += 1;
    pttCancelledRef.current = false;
    setIsPttActive(false);
    setPttWarming(false);

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
    pttCancelledRef.current = true;
    setIsPttActive(false);
    setPttWarming(false);
    clearTranscriptTimer();
    setPttPartial(null);
    pttCommittedRef.current = '';
    setPttPhase('idle');
    if (pttSendTimerRef.current !== null) {
      window.clearTimeout(pttSendTimerRef.current);
      pttSendTimerRef.current = null;
    }
    if (daemonPttRef.current) {
      daemonPttRef.current = false;
      captureRef.current?.stop();
      captureRef.current = null;
      linuxClient.cancelDictation();
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

  // Warm the microphone before the user reaches for the button and keep it warm
  // while the app is in the foreground, so push-to-talk starts on the first
  // syllable instead of losing it to capture start-up. The mic is released the
  // moment the app is backgrounded (see audioCapture's visibility handler).
  useEffect(() => {
    void warmMic();
    const keepWarm = () => {
      if (document.visibilityState === 'visible') void warmMic();
    };
    const id = window.setInterval(keepWarm, 15000);
    document.addEventListener('visibilitychange', keepWarm);
    window.addEventListener('pointerdown', keepWarm, true);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', keepWarm);
      window.removeEventListener('pointerdown', keepWarm, true);
    };
  }, []);

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

  // Reconnect on launch so the deck is usable immediately. The phone tries the
  // same-hotspot link first (fast, free of mobile data) and falls back to the
  // tailnet name, so a self-signed link it has not been taught still lands on
  // the working Tailscale route instead of just failing.
  const didAutoConnectRef = useRef(false);
  const connectChainRef = useRef<{ hosts: string[]; index: number } | null>(null);
  const connectTimerRef = useRef<number | null>(null);

  const clearConnectTimer = () => {
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  };

  const armConnectTimer = (host: string) => {
    clearConnectTimer();
    connectTimerRef.current = window.setTimeout(() => {
      if (!linuxClient.getStatus().connected) advanceConnect(host);
    }, 3500);
  };

  const advanceConnect = (failedHost: string) => {
    const chain = connectChainRef.current;
    // Stale signal (we already moved past this host): ignore it.
    if (!chain || chain.hosts[chain.index] !== failedHost) return;
    clearConnectTimer();
    if (chain.index >= chain.hosts.length - 1) {
      connectChainRef.current = null;
      return;
    }
    chain.index += 1;
    const host = chain.hosts[chain.index];
    linuxClient.connect(host);
    armConnectTimer(host);
  };

  const connectPreferred = (hosts: string[]) => {
    const list = hosts.map((h) => h.trim()).filter(Boolean);
    if (!list.length) return;
    connectChainRef.current = { hosts: list, index: 0 };
    linuxClient.connect(list[0]);
    armConnectTimer(list[0]);
  };

  useEffect(() => {
    if (didAutoConnectRef.current) return;
    didAutoConnectRef.current = true;
    if (!settings.autoConnect) return;
    const saved =
      loadSavedLaptops().find((l) => l.host === settings.tailscaleIp) ??
      loadSavedLaptops()[0] ??
      null;
    const hosts = autoconnectOrder({
      localHost: LOCAL_HOST,
      saved,
      fallbackHost: settings.tailscaleIp,
      preferLocal: settings.preferLocal,
    });
    if (hosts.length) connectPreferred(hosts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.autoConnect, settings.tailscaleIp, settings.preferLocal]);

  // Let a failed attempt (or a hung one) hand off to the next candidate. A host
  // we never asked for means the user connected by hand, so the chain stands down.
  useEffect(() => {
    const chain = connectChainRef.current;
    if (!chain) return;
    if (connectionStatus.connected) {
      connectChainRef.current = null;
      clearConnectTimer();
      return;
    }
    if (connectionStatus.connecting) return;
    if (!chain.hosts.includes(connectionStatus.hostAddress)) {
      connectChainRef.current = null;
      clearConnectTimer();
      return;
    }
    advanceConnect(connectionStatus.hostAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus.connected, connectionStatus.connecting, connectionStatus.error, connectionStatus.hostAddress]);

  // A dead link should hand the user a way back in, not a dead end. When the
  // app has settled into "not connected", surface the setup QR screen once, so
  // the address and codes are already on screen instead of buried in a menu.
  const setupAutoShownRef = useRef(false);
  useEffect(() => {
    if (connectionStatus.connected) {
      if (setupAutoShownRef.current) setShowSetup(false);
      setupAutoShownRef.current = false;
      return;
    }
    if (connectionStatus.connecting) return;
    if (setupAutoShownRef.current) return;
    const timer = window.setTimeout(() => {
      if (setupAutoShownRef.current) return;
      setupAutoShownRef.current = true;
      setShowSetup(true);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [connectionStatus.connected, connectionStatus.connecting, connectionStatus.hostAddress]);

  // Remember whichever host actually answered, so the address is never retyped.
  const persistedHostRef = useRef<string | null>(null);
  useEffect(() => {
    const host = connectionStatus.hostAddress?.trim();
    if (!host || host === persistedHostRef.current) return;
    persistedHostRef.current = host;
    if (host === settings.tailscaleIp) return;
    // The hotspot address is derived from the page origin, so storing it would
    // only print it back into the visible address field.
    if (host === LOCAL_HOST) return;
    handleUpdateSettings({ tailscaleIp: host });
  }, [connectionStatus.hostAddress, settings.tailscaleIp]);

  useEffect(() => {
    if (!IS_LOCAL_MODE) return;
    // A browser only exposes the microphone in a secure context, and a plain
    // http LAN address is not one. Trackpad and keys work; talking cannot.
    // Say so here rather than let the mic button fail without explanation.
    const secure = typeof window !== 'undefined' && window.isSecureContext;
    showToast(
      secure
        ? 'Local mode: connected straight over the hotspot'
        : 'Same hotspot: trackpad and keys work. For talking, open Setup and use the https :8443 link',
      secure ? 'ok' : 'warn',
    );
  }, [showToast]);

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
    const route = describeRoute(connectionStatus.hostAddress, IS_LOCAL_MODE, connected);
    void showConnectionNotice({ connected, host, route }).then((posted) => {
      if (posted) return;
      showToast(
        connected ? `Connected to ${host} · ${route}` : `Disconnected from ${host}`,
        connected ? 'ok' : 'warn',
      );
    });
  }, [connectionStatus.connected, connectionStatus.hostAddress, settings.connectionAlerts, showToast]);

  // Laptop-initiated notices: the daemon pushes `notify` over the live socket,
  // so anything the laptop wants to say reaches the phone as a pop-up.
  useEffect(() => {
    return linuxClient.onNotify(({ title, body }) => {
      void showMessageNotice({ title, body }).then((posted) => {
        if (!posted) showToast(body, 'ok');
      });
    });
  }, [showToast]);

  // The laptop asking this phone to sign an unlock challenge: prompt for the
  // fingerprint and hand the assertion straight back over the same socket.
  const authInFlightRef = useRef(false);
  useEffect(() => {
    return linuxClient.onAuthChallenge((challenge) => {
      if (authInFlightRef.current) return;
      if (!webAuthnAvailable()) {
        showToast('Open the app from its web address to unlock with your phone', 'warn');
        return;
      }
      authInFlightRef.current = true;
      void respondToChallenge(challenge)
        .then((assertion) => {
          if (!assertion) return;
          linuxClient.sendAuthResponse(assertion);
          showToast('Fingerprint sent to the laptop', 'ok');
        })
        .finally(() => {
          authInFlightRef.current = false;
        });
    });
  }, [showToast]);

  // Remember every laptop we actually reach, so the drawer can offer it again
  // with one tap instead of retyping an address or a tailnet name. The other
  // routes it answered on are kept too, so the next launch can try the local
  // link first and fall back to Tailscale.
  useEffect(() => {
    if (!connectionStatus.connected || !connectionStatus.hostAddress) return;
    const info = connectionStatus.hostOsInfo;
    const httpsPort = info?.ports?.https ?? 8443;
    const alt = (info?.addresses ?? [])
      .filter((ip) => !isTailnetIp(ip))
      .map((ip) => `${ip}:${httpsPort}`);
    rememberLaptop(connectionStatus.hostAddress, info?.hostname ?? '', {
      alt,
      tailnet: info?.tailnet ?? null,
    });
  }, [
    connectionStatus.connected,
    connectionStatus.hostAddress,
    connectionStatus.hostOsInfo?.hostname,
  ]);

  const handleAppSwitch = (direction: 'prev' | 'next') => {
    setActiveAppIndex((prev) => {
      return direction === 'next' ? (prev + 1) % 6 : (prev - 1 + 6) % 6;
    });
  };

  // Dark-out blacks the panel but keeps the app foregrounded and awake, so the
  // websocket survives. Go fullscreen in the same tap that triggers this, or
  // the browser chrome would sit bright above an otherwise black screen.
  const enterDarkOut = useCallback(() => {
    try {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch {
      // iOS Safari has no element fullscreen; installed copies already are.
    }
    setIsDrawerOpen(false);
    setDarkOut(true);
  }, []);

  // Either the mic is live, or we are still opening it right after the press.
  // Both read as "Listening…" so the feedback is instant.
  const pttListening = isPttActive || pttWarming;

  return (
    <div
      className="flex flex-col h-[100dvh] w-full bg-slate-950 text-slate-100 font-sans select-none overflow-hidden touch-none relative"
      style={{ '--td-scale': effectiveButtonScale } as CSSProperties}
    >
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
            buttonScale={effectiveButtonScale}
            onButtonScaleChange={setButtonScalePreview}
            onButtonScaleCommit={(scale) => {
              setButtonScalePreview(null);
              handleUpdateSettings({ buttonScale: scale });
            }}
          />
        </div>
      </main>

      {/* Slide-In Full Menu Drawer (Drag in from side or tap left edge handle) */}
      <SideMenuDrawer
        isOpen={isDrawerOpen}
        onOpen={() => setIsDrawerOpen(true)}
        onClose={() => {
          setIsDrawerOpen(false);
          setDrawerTab(undefined);
        }}
        openTab={drawerTab}
        connectionStatus={connectionStatus}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onToggleSimulator={() => setShowSimulator((prev) => !prev)}
        onOpenDictation={() => setIsDictationOpen(true)}
        onOpenDiagnostics={() => setShowDiagnostics(true)}
        onOpenSetup={() => {
          setIsDrawerOpen(false);
          setShowSetup(true);
        }}
        isSimulatorActive={showSimulator}
        onEnterDarkOut={enterDarkOut}
        appUpdateReady={appUpdateReady}
        onApplyAppUpdate={applyAppUpdate}
      />

      {/* Setup / QR: the whole way in, on one screen. Opens itself when the app
          has no connection so a phone can be pointed at it and paired. */}
      <SetupQrScreen
        isOpen={showSetup}
        onClose={() => setShowSetup(false)}
        status={connectionStatus}
        onScan={() => {
          setShowSetup(false);
          setDrawerTab('tailscale');
          setIsDrawerOpen(true);
        }}
      />

      {/* Full-screen push-to-talk state: the mic button sits under the thumb,
          so the deck itself has to show what is happening. The laptop types
          into its own focused window, which the phone cannot see, so the
          transcript is echoed back here as the only confirmation available. */}
      {(pttListening || pttPhase === 'transcribing') && (
        <div className="fixed inset-0 z-20 pointer-events-none flex flex-col items-center justify-center">
          <div
            className={`absolute inset-0 ${pttListening ? 'bg-rose-950/25' : 'bg-slate-950/35'}`}
          />
          <div className="relative flex items-center gap-3 px-5 py-3 rounded-2xl bg-slate-950/85 border border-rose-500/50 shadow-lg shadow-black/60">
            {pttListening ? (
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
            {pttListening ? 'Release to send to your laptop' : 'Typing on your laptop'}
          </p>
        </div>
      )}

      {/* Streaming preview while the phone is still holding the mic. */}
      {pttPartial && !pttTranscript && (
        <div className="fixed inset-x-0 bottom-4 z-30 px-4 pointer-events-none flex justify-center">
          <div className="max-w-md w-full px-4 py-3 rounded-2xl bg-slate-900/90 border border-sky-500/40 shadow-lg shadow-black/60">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                Hearing…
              </span>
            </div>
            <p className="text-sm text-slate-100 line-clamp-3">{pttPartial}</p>
          </div>
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

      {showDiagnostics && (
        <SpeechDiagnosticsPanel
          diagnostics={speech.diagnostics}
          buildSha={__BUILD_SHA__}
          error={speech.error}
          permission={speech.permission}
          route={{
            origin: typeof location !== 'undefined' ? location.origin : '',
            servedBy: servedByLabel(),
            route: describeRoute(
              connectionStatus.hostAddress,
              IS_LOCAL_MODE,
              connectionStatus.connected,
            ),
            host: connectionStatus.hostAddress || '—',
            transport:
              typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws',
            latencyMs: connectionStatus.latencyMs,
            localMode: IS_LOCAL_MODE,
          }}
          onClose={() => setShowDiagnostics(false)}
        />
      )}

      {/* Floating Mic: push-to-talk on touch-down, release to send, drag to move */}
      <FloatingDictationButton
        onTriggerDictation={() => setIsDictationOpen(true)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
        isPushToTalkActive={isPttActive}
        onPushToTalkStart={handlePttStart}
        onPushToTalkEnd={handlePttEnd}
        onPushToTalkCancel={handlePttCancel}
        enterMode={enterPrompt}
        onEnterKey={() => {
          armEnterPrompt();
          linuxClient.sendKeyCombo(['Return']);
        }}
        onBackspace={() => {
          armEnterPrompt();
          linuxClient.sendKeyCombo(['BackSpace']);
        }}
        onExitEnterMode={exitEnterPrompt}
        onCommand={(cmd) => linuxClient.sendMedia(cmd)}
      />

      {/* Voice Dictation Input Sheet */}
      <DictationModal
        isOpen={isDictationOpen}
        onClose={() => setIsDictationOpen(false)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
        host={connectionStatus.hostAddress}
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

      {/* Dark-out overlay: black the whole panel, exit with a swipe up from the
          bottom edge. Rendered last so it covers every other layer. */}
      <DarkOut active={darkOut} onExit={() => setDarkOut(false)} />
    </div>
  );
}
