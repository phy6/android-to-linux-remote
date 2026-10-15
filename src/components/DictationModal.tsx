import React, { useEffect, useState } from 'react';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import { Mic, MicOff, Send, CornerDownLeft, Trash2, X, Globe, Sparkles, AlertCircle } from 'lucide-react';

interface DictationModalProps {
  isOpen: boolean;
  onClose: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
}

const LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'de-DE', label: 'German' },
  { code: 'fr-FR', label: 'French' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
];

export const DictationModal: React.FC<DictationModalProps> = ({
  isOpen,
  onClose,
  hapticsEnabled,
  soundEnabled,
}) => {
  const {
    isListening,
    transcript,
    setTranscript,
    interimTranscript,
    error,
    isSupported,
    language,
    setLanguage,
    startListening,
    stopListening,
    resetTranscript,
  } = useSpeechRecognition();

  const { triggerClick, triggerHeavyClick } = useHaptics(hapticsEnabled, soundEnabled);
  const [manualText, setManualText] = useState('');

  // Start listening automatically when modal opens
  useEffect(() => {
    if (isOpen) {
      startListening();
    } else {
      stopListening();
    }
  }, [isOpen, startListening, stopListening]);

  if (!isOpen) return null;

  const displayText = transcript + (interimTranscript ? ` ${interimTranscript}` : '') || manualText;

  const handleSendText = (appendEnter = false) => {
    const textToSend = displayText.trim();
    if (!textToSend) return;

    triggerClick();
    linuxClient.sendTypeText(textToSend);
    if (appendEnter) {
      linuxClient.sendKeyCombo(['Return']);
    }

    resetTranscript();
    setManualText('');
    stopListening();
    onClose();
  };

  const handleToggleListening = () => {
    triggerClick();
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/70">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base leading-tight">
                Voice Dictation Input
              </h3>
              <p className="text-xs text-slate-400">
                Long-pressed Left Click • Types directly into Linux
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              triggerClick();
              stopListening();
              onClose();
            }}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Microphone Wave Visualizer & Status */}
        <div className="p-6 flex flex-col items-center justify-center bg-gradient-to-b from-slate-950/40 to-slate-900">
          <div className="relative mb-4 flex items-center justify-center">
            {isListening && (
              <>
                <span className="absolute w-24 h-24 rounded-full bg-sky-500/20 animate-ping" />
                <span className="absolute w-20 h-20 rounded-full bg-sky-400/30 animate-pulse" />
              </>
            )}

            <button
              onClick={handleToggleListening}
              className={`relative z-10 w-16 h-16 rounded-full flex items-center justify-center border-2 transition-all shadow-lg active:scale-95 ${
                isListening
                  ? 'bg-rose-600 border-rose-400 text-white shadow-rose-600/40'
                  : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {isListening ? (
                <Mic className="w-8 h-8 animate-bounce" />
              ) : (
                <MicOff className="w-7 h-7 text-slate-400" />
              )}
            </button>
          </div>

          <div className="text-center">
            <span
              className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
                isListening
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              {isListening ? 'Listening... Speak naturally' : 'Paused (Tap mic to speak)'}
            </span>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/40 px-3 py-1.5 rounded-lg border border-amber-800/60 max-w-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Live Transcription Box */}
        <div className="px-5 py-2 flex-1">
          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-1 block">
            Live Transcription / Text Buffer:
          </label>
          <div className="relative">
            <textarea
              value={displayText}
              onChange={(e) => {
                setManualText(e.target.value);
                setTranscript(e.target.value);
              }}
              placeholder="Your speech or typed text will appear here. It will type into your active Linux window..."
              rows={4}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-2xl p-3.5 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-sky-500 resize-none font-sans"
            />
            {displayText && (
              <button
                onClick={() => {
                  triggerClick();
                  resetTranscript();
                  setManualText('');
                }}
                className="absolute top-2.5 right-2.5 p-1 rounded-lg bg-slate-800 text-slate-400 hover:text-rose-400"
                title="Clear text"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Footer Controls & Send Buttons */}
        <div className="p-5 border-t border-slate-800 bg-slate-950/80 flex flex-col gap-3">
          {/* Language Selector */}
          <div className="flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-sky-400" />
              <span>Language:</span>
            </div>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleSendText(false)}
              disabled={!displayText.trim()}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm bg-slate-800 text-white border border-slate-700 hover:bg-slate-700 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition"
            >
              <Send className="w-4 h-4 text-sky-400" />
              <span>Type Text</span>
            </button>

            <button
              onClick={() => handleSendText(true)}
              disabled={!displayText.trim()}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm bg-sky-600 text-white hover:bg-sky-500 shadow-lg shadow-sky-600/30 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition"
            >
              <CornerDownLeft className="w-4 h-4" />
              <span>Type + Enter</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
