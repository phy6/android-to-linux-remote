import React, { useEffect, useRef, useState } from 'react';
import { SpeechRecognitionController } from '../hooks/useSpeechRecognition';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import {
  listScripts,
  getScript,
  saveScript,
  listLocalSnippets,
  saveLocalSnippet,
  deleteLocalSnippet,
  suggestScriptName,
  ScriptFile,
  LocalSnippet,
} from '../services/scriptsClient';
import {
  Mic,
  MicOff,
  Send,
  CornerDownLeft,
  Trash2,
  X,
  Globe,
  Sparkles,
  AlertCircle,
  Play,
  Pause,
  RefreshCw,
  Save,
  FileText,
  FolderOpen,
  Minus,
  Plus,
} from 'lucide-react';

interface DictationModalProps {
  isOpen: boolean;
  onClose: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  /** host:port currently connected, used to fetch scripts from the laptop. */
  host?: string;
  speech: SpeechRecognitionController;
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

const MIN_SPEED = 8;
const MAX_SPEED = 120;
const MIN_FONT = 16;
const MAX_FONT = 40;

export const DictationModal: React.FC<DictationModalProps> = ({
  isOpen,
  onClose,
  hapticsEnabled,
  soundEnabled,
  host = '',
  speech,
}) => {
  const {
    isListening,
    transcript,
    setTranscript,
    interimTranscript,
    error,
    language,
    setLanguage,
    startListening,
    stopListening,
    resetTranscript,
  } = speech;

  const { triggerClick, triggerHeavyClick } = useHaptics(hapticsEnabled, soundEnabled);

  const [manualText, setManualText] = useState('');
  const [scriptText, setScriptText] = useState('');
  const [scripts, setScripts] = useState<ScriptFile[]>([]);
  const [locals, setLocals] = useState<LocalSnippet[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(28);
  const [fontSize, setFontSize] = useState(22);

  const prompterRef = useRef<HTMLTextAreaElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const speedRef = useRef(speed);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // Listen while the sheet is open; stop and freeze the prompter on close.
  useEffect(() => {
    if (isOpen) {
      startListening();
    } else {
      stopListening();
      setPlaying(false);
    }
  }, [isOpen, startListening, stopListening]);

  // Pull the laptop's script list (and this phone's own snippets) when opened.
  useEffect(() => {
    if (!isOpen) return;
    setLocals(listLocalSnippets());
    if (!host) {
      setScripts([]);
      return;
    }
    let cancelled = false;
    setLoadingList(true);
    void listScripts(host).then((found) => {
      if (cancelled) return;
      setScripts(found);
      setLoadingList(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, host]);

  // Fixed-speed teleprompter: advance the scroll by `speed` px per second.
  useEffect(() => {
    if (!playing) return;
    lastTsRef.current = performance.now();
    const step = (ts: number) => {
      const el = prompterRef.current;
      if (!el) {
        rafRef.current = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;
      el.scrollTop += speedRef.current * dt;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

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

  const loadScript = async (value: string) => {
    if (!value) return;
    triggerClick();
    const [source, ...rest] = value.split(':');
    const name = rest.join(':');
    let text: string | null = null;
    if (source === 'local') {
      text = locals.find((s) => s.name === name)?.text ?? null;
    } else if (source === 'laptop' && host) {
      text = await getScript(host, name);
    }
    if (text !== null) {
      setScriptText(text);
      if (prompterRef.current) prompterRef.current.scrollTop = 0;
      setPlaying(false);
    } else {
      triggerHeavyClick();
    }
  };

  const handleLoadFromFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setScriptText(String(reader.result ?? ''));
      if (prompterRef.current) prompterRef.current.scrollTop = 0;
      setPlaying(false);
    };
    reader.readAsText(file);
  };

  const handleSave = async () => {
    if (!scriptText.trim()) return;
    triggerClick();
    const suggested = suggestScriptName();
    const entered = window.prompt('Save script as (a name)', suggested);
    if (!entered) return;
    let name = entered.trim();
    if (!/\.(txt|md|markdown)$/i.test(name)) name += '.txt';

    setLocals(saveLocalSnippet(name, scriptText));
    if (host) {
      const ok = await saveScript(host, name, scriptText);
      if (!ok) {
        // Some laptop browsers of the daemon are reachable, but a missing
        // endpoint should not lose the snippet; the local copy stays.
      }
    }
    setPlaying(false);
  };

  const removeLocal = (name: string) => {
    triggerHeavyClick();
    setLocals(deleteLocalSnippet(name));
  };

  const togglePlay = () => {
    triggerClick();
    const el = prompterRef.current;
    if (!playing && el) el.scrollTop = 0;
    setPlaying((p) => !p);
  };

  const clampSpeed = (v: number) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(v)));
  const clampFont = (v: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(v)));

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[92vh] sm:h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-950/70 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base leading-tight">Dictation &amp; Script</h3>
              <p className="text-xs text-slate-400">Read the script, verify the transcript below</p>
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

        {/* Script picker */}
        <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-950/40 shrink-0 flex items-center gap-2">
          <FileText className="w-4 h-4 text-sky-400 shrink-0" />
          <select
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = '';
              void loadScript(v);
            }}
            className="flex-1 min-w-0 bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="">Load a script…</option>
            {scripts.length > 0 && (
              <optgroup label="On the laptop">
                {scripts.map((s) => (
                  <option key={`laptop:${s.name}`} value={`laptop:${s.name}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
            {locals.length > 0 && (
              <optgroup label="On this phone">
                {locals.map((s) => (
                  <option key={`local:${s.name}`} value={`local:${s.name}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            onClick={() => {
              triggerClick();
              setLocals(listLocalSnippets());
              if (host) {
                setLoadingList(true);
                void listScripts(host).then((f) => {
                  setScripts(f);
                  setLoadingList(false);
                });
              }
            }}
            className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
            title="Refresh scripts"
          >
            <RefreshCw className={`w-4 h-4 ${loadingList ? 'animate-spin' : ''}`} />
          </button>
          <label className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:text-white cursor-pointer" title="Open a file from this phone">
            <FolderOpen className="w-4 h-4" />
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLoadFromFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {/* Script / teleprompter (upper area) */}
        <div className="flex-1 min-h-0 flex flex-col bg-slate-950/40">
          <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0">
            <button
              onClick={togglePlay}
              disabled={!scriptText.trim()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 active:scale-95"
            >
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {playing ? 'Pause' : 'Scroll'}
            </button>
            <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">Speed</span>
            <button
              onClick={() => setSpeed((s) => clampSpeed(s - 6))}
              className="p-1 rounded bg-slate-800 text-slate-300 hover:text-white"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-slate-300 w-8 text-center tabular-nums">{speed}</span>
            <button
              onClick={() => setSpeed((s) => clampSpeed(s + 6))}
              className="p-1 rounded bg-slate-800 text-slate-300 hover:text-white"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-2">Text</span>
            <button
              onClick={() => setFontSize((f) => clampFont(f - 2))}
              className="p-1 rounded bg-slate-800 text-slate-300 hover:text-white"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setFontSize((f) => clampFont(f + 2))}
              className="p-1 rounded bg-slate-800 text-slate-300 hover:text-white"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleSave}
              disabled={!scriptText.trim()}
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              title="Save as a reusable snippet (phone and laptop)"
            >
              <Save className="w-3.5 h-3.5" /> Save
            </button>
          </div>

          <textarea
            ref={prompterRef}
            value={scriptText}
            onChange={(e) => setScriptText(e.target.value)}
            placeholder="Paste or load the text to read aloud. Press Scroll and it glides at a steady speed."
            spellCheck={false}
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.5 }}
            className="flex-1 min-h-0 w-full bg-slate-950 text-slate-50 placeholder-slate-600 px-4 py-3 focus:outline-none resize-none font-serif"
          />
        </div>

        {/* Transcript verification (lower, small) */}
        <div className="px-4 pt-2 pb-1 border-t border-slate-800 bg-slate-900 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  isListening ? 'bg-rose-500 animate-pulse' : 'bg-slate-600'
                }`}
              />
              Heard {isListening ? '(listening)' : '(paused)'}
            </label>
            <div className="flex items-center gap-1">
              {displayText && (
                <button
                  onClick={() => {
                    triggerClick();
                    resetTranscript();
                    setManualText('');
                  }}
                  className="p-1 rounded bg-slate-800 text-slate-400 hover:text-rose-400"
                  title="Clear"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={handleToggleListening}
                className={`p-1.5 rounded-lg border ${
                  isListening
                    ? 'bg-rose-600 border-rose-400 text-white'
                    : 'bg-slate-800 border-slate-600 text-slate-300'
                }`}
                title={isListening ? 'Pause microphone' : 'Start microphone'}
              >
                {isListening ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <textarea
            value={displayText}
            onChange={(e) => {
              setManualText(e.target.value);
              setTranscript(e.target.value);
            }}
            placeholder="What is heard appears here…"
            rows={2}
            className="w-full bg-slate-950 border border-slate-700/70 rounded-xl px-3 py-2 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-sky-500 resize-none"
          />
          {error && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/40 px-3 py-1.5 rounded-lg border border-amber-800/60">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer: language + send */}
        <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/80 shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-sky-400" />
              <span>Language</span>
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
            {locals.length > 0 && (
              <button
                onClick={() => {
                  const name = locals[locals.length - 1]?.name;
                  if (name) removeLocal(name);
                }}
                className="text-[11px] text-slate-500 hover:text-rose-400"
                title="Remove the last saved phone snippet"
              >
                {locals.length} on phone
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleSendText(false)}
              disabled={!displayText.trim()}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-sm bg-slate-800 text-white border border-slate-700 hover:bg-slate-700 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition"
            >
              <Send className="w-4 h-4 text-sky-400" />
              <span>Type Heard</span>
            </button>
            <button
              onClick={() => handleSendText(true)}
              disabled={!displayText.trim()}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-sm bg-sky-600 text-white hover:bg-sky-500 shadow-lg shadow-sky-600/30 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition"
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
