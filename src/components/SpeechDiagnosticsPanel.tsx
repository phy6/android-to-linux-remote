import React from 'react';
import { SpeechDiagnostics } from '../hooks/useSpeechRecognition';

interface SpeechDiagnosticsPanelProps {
  diagnostics: SpeechDiagnostics;
  error: string | null;
  permission: string;
  onClose: () => void;
}

const rows = (d: SpeechDiagnostics) => [
  ['Speech API', d.hasSpeechApi ? 'available' : 'MISSING'],
  ['Display mode', d.displayMode],
  ['Secure context', d.secureContext ? 'yes' : 'no'],
  ['getUserMedia', d.hasGetUserMedia ? 'available' : 'MISSING'],
  ['Permission', d.permission],
  ['Mic track', d.micTrackState ?? 'released'],
  ['Engine started', d.engineStarted ? 'yes' : 'not yet'],
  ['Start attempts', String(d.attempts)],
  ['Last error', d.lastError ?? 'none'],
];

export const SpeechDiagnosticsPanel: React.FC<SpeechDiagnosticsPanelProps> = ({
  diagnostics,
  error,
  permission,
  onClose,
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
    <div className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-700 p-4 shadow-2xl">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Dictation diagnostics</h3>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-lg bg-slate-800 text-xs text-slate-300 hover:text-white"
        >
          Close
        </button>
      </div>

      {error && (
        <p className="mb-3 text-[11px] text-amber-300 bg-amber-950/50 border border-amber-800/60 rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}

      <dl className="text-[11px] font-mono">
        {rows(diagnostics).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-1 border-b border-slate-800/70 last:border-0">
            <dt className="text-slate-400">{k}</dt>
            <dd className="text-slate-200 text-right break-all">{v}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 py-1">
          <dt className="text-slate-400">Reported permission</dt>
          <dd className="text-slate-200 text-right">{permission}</dd>
        </div>
      </dl>

      <p className="mt-3 text-[10px] text-slate-500 leading-relaxed">
        Hold the mic first, then reopen this panel to see what the speech engine reported.
      </p>
    </div>
  </div>
);