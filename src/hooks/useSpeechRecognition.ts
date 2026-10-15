import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API definitions
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: () => void;
  onend: () => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onresult: (event: SpeechRecognitionEvent) => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

export type MicPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported';

const MIC_UNSUPPORTED_MESSAGE =
  'Speech recognition is not supported in this browser. Chrome or Edge on Android is required.';

const MIC_DENIED_MESSAGE =
  'Microphone blocked. Open your browser site settings, allow the microphone for this site, then hold the mic again.';

const START_TIMEOUT_MS = 6000;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const getSpeechRecognition = (): SpeechRecognitionConstructor | undefined =>
  window.SpeechRecognition || window.webkitSpeechRecognition;

export type SpeechRecognitionController = ReturnType<typeof useSpeechRecognition>;

export interface SpeechDiagnostics {
  hasSpeechApi: boolean;
  secureContext: boolean;
  hasGetUserMedia: boolean;
  permission: MicPermissionState;
  lastError: string | null;
  engineStarted: boolean;
  attempts: number;
  micTrackState: string | null;
  displayMode: string;
}

export function useSpeechRecognition(defaultLang = 'en-US') {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(defaultLang);
  const [isSupported, setIsSupported] = useState(true);
  const [permission, setPermission] = useState<MicPermissionState>('unknown');
  const [diagnostics, setDiagnostics] = useState<SpeechDiagnostics>({
    hasSpeechApi: false,
    secureContext: false,
    hasGetUserMedia: false,
    permission: 'unknown',
    lastError: null,
    engineStarted: false,
    attempts: 0,
    micTrackState: null,
    displayMode: 'browser',
  });

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef('');
  const engineStartedRef = useRef(false);
  const startTimeoutRef = useRef<number | null>(null);
  // The probe stream is held open for the whole listening session. Releasing it
  // immediately makes some Android builds refuse to hand the mic to the
  // recogniser afterwards.
  const micStreamRef = useRef<MediaStream | null>(null);

  const diagnosticsRef = useRef<SpeechDiagnostics>({
    hasSpeechApi: false,
    secureContext: false,
    hasGetUserMedia: false,
    permission: 'unknown',
    lastError: null,
    engineStarted: false,
    attempts: 0,
    micTrackState: null,
    displayMode: 'browser',
  });

  const patchDiagnostics = useCallback((patch: Partial<SpeechDiagnostics>) => {
    setDiagnostics((prev) => {
      const next = { ...prev, ...patch };
      diagnosticsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    setIsSupported(!!getSpeechRecognition());
    const mode = window.matchMedia('(display-mode: standalone)').matches
      ? 'installed app'
      : window.matchMedia('(display-mode: fullscreen)').matches
        ? 'fullscreen'
        : 'browser';
    patchDiagnostics({
      hasSpeechApi: !!getSpeechRecognition(),
      secureContext: window.isSecureContext,
      hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
      displayMode: mode,
    });
  }, [patchDiagnostics]);

  const releaseMic = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      patchDiagnostics({ micTrackState: null });
    }
  }, [patchDiagnostics]);

  const clearStartTimeout = useCallback(() => {
    if (startTimeoutRef.current !== null) {
      window.clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearStartTimeout, [clearStartTimeout]);

  const setTranscriptValue = useCallback((value: string) => {
    transcriptRef.current = value;
    setTranscript(value);
  }, []);

  // Chrome fires no events at all when the microphone is unavailable or the
  // permission was previously dismissed, so the permission must be requested
  // explicitly to get a real error instead of an indefinite silent hang.
  const ensureMicPermission = useCallback(async (): Promise<boolean> => {
    if (!getSpeechRecognition()) {
      setPermission('unsupported');
      patchDiagnostics({ lastError: 'no-speech-api' });
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      patchDiagnostics({ lastError: 'no-getusermedia' });
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Keep the track open so the recogniser can reuse it.
      micStreamRef.current = stream;
      const state = stream.getAudioTracks()[0]?.readyState ?? 'unknown';
      setPermission('granted');
      patchDiagnostics({ permission: 'granted', micTrackState: state, lastError: null });
      return true;
    } catch (err) {
      const name = (err as DOMException | undefined)?.name ?? 'Error';
      patchDiagnostics({ lastError: `getUserMedia:${name}` });
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPermission('denied');
        setError(MIC_DENIED_MESSAGE);
      } else {
        setPermission('unknown');
        setError(`Microphone unavailable (${name}).`);
      }
      return false;
    }
  }, [patchDiagnostics]);

  const stopListening = useCallback(() => {
    clearStartTimeout();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore
      }
    }
    setIsListening(false);
    releaseMic();
  }, [clearStartTimeout, releaseMic]);

  const abortListening = useCallback(() => {
    clearStartTimeout();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore
      }
    }
    setIsListening(false);
    releaseMic();
  }, [clearStartTimeout, releaseMic]);

  const startListening = useCallback(async (): Promise<boolean> => {
    setError(null);
    setInterimTranscript('');

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setIsSupported(false);
      setPermission('unsupported');
      setError(MIC_UNSUPPORTED_MESSAGE);
      return false;
    }

    const permitted = await ensureMicPermission();
    if (!permitted) return false;

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore
        }
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = language;

      engineStartedRef.current = false;
      patchDiagnostics({ attempts: diagnosticsRef.current.attempts + 1, engineStarted: false, lastError: null });
      recognition.onstart = () => {
        engineStartedRef.current = true;
        clearStartTimeout();
        patchDiagnostics({ engineStarted: true, lastError: null });
        setIsListening(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalStr = '';
        let interimStr = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item.isFinal) {
            finalStr += item[0].transcript;
          } else {
            interimStr += item[0].transcript;
          }
        }

        if (finalStr) {
          setTranscriptValue(
            (transcriptRef.current ? `${transcriptRef.current} ` : '') + finalStr.trim()
          );
        }
        setInterimTranscript(interimStr);
      };

      recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
        clearStartTimeout();
        patchDiagnostics({ lastError: `speech:${e.error}` });
        if (e.error === 'no-speech') return;
        if (e.error === 'aborted') return;
        setError(`Speech error: ${e.error}`);
        setIsListening(false);
        releaseMic();
      };

      recognition.onend = () => {
        clearStartTimeout();
        setIsListening(false);
        releaseMic();
      };

      recognition.start();
      recognitionRef.current = recognition;

      // No onstart within the window means the engine never came up.
      clearStartTimeout();
      startTimeoutRef.current = window.setTimeout(() => {
        if (engineStartedRef.current) return;
        try {
          recognition.abort();
        } catch {
          // Ignore
        }
        setIsListening(false);
        patchDiagnostics({ lastError: 'engine-timeout', engineStarted: false });
        setError(
          'Speech engine did not start. Close other apps using the microphone and try again.'
        );
      }, START_TIMEOUT_MS);

      return true;
    } catch (err) {
      clearStartTimeout();
      setError('Could not initialize speech recognition.');
      setIsListening(false);
      return false;
    }
  }, [language, ensureMicPermission, clearStartTimeout, setTranscriptValue, patchDiagnostics, releaseMic]);

  const resetTranscript = useCallback(() => {
    setInterimTranscript('');
    setTranscriptValue('');
  }, [setTranscriptValue]);

  return {
    isListening,
    transcript,
    setTranscript: setTranscriptValue,
    transcriptRef,
    interimTranscript,
    error,
    isSupported,
    permission,
    diagnostics,
    language,
    setLanguage,
    startListening,
    stopListening,
    abortListening,
    resetTranscript,
    ensureMicPermission,
  };
}