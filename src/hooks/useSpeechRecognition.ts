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

const START_TIMEOUT_MS = 2500;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const getSpeechRecognition = (): SpeechRecognitionConstructor | undefined =>
  window.SpeechRecognition || window.webkitSpeechRecognition;

export type SpeechRecognitionController = ReturnType<typeof useSpeechRecognition>;

export function useSpeechRecognition(defaultLang = 'en-US') {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(defaultLang);
  const [isSupported, setIsSupported] = useState(true);
  const [permission, setPermission] = useState<MicPermissionState>('unknown');

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef('');
  const engineStartedRef = useRef(false);
  const startTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setIsSupported(!!getSpeechRecognition());
  }, []);

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
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermission('granted');
      return true;
    } catch (err) {
      const name = (err as DOMException | undefined)?.name ?? 'Error';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPermission('denied');
        setError(MIC_DENIED_MESSAGE);
      } else {
        setPermission('unknown');
        setError(`Microphone unavailable (${name}).`);
      }
      return false;
    }
  }, []);

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
  }, [clearStartTimeout]);

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
  }, [clearStartTimeout]);

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
      recognition.onstart = () => {
        engineStartedRef.current = true;
        clearStartTimeout();
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
        if (e.error === 'no-speech') return;
        if (e.error === 'aborted') return;
        setError(`Speech error: ${e.error}`);
        setIsListening(false);
      };

      recognition.onend = () => {
        clearStartTimeout();
        setIsListening(false);
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
  }, [language, ensureMicPermission, clearStartTimeout, setTranscriptValue]);

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
    language,
    setLanguage,
    startListening,
    stopListening,
    abortListening,
    resetTranscript,
    ensureMicPermission,
  };
}