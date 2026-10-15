import React from 'react';
import { RemoteSettings } from '../types';
import { useHaptics } from '../hooks/useHaptics';
import { Sliders, X, RotateCcw, Volume2, Vibrate, MousePointer, Gauge } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: RemoteSettings;
  onUpdateSettings: (newSettings: Partial<RemoteSettings>) => void;
  onResetDefaults: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onResetDefaults,
}) => {
  const { triggerClick } = useHaptics(settings.hapticFeedback, settings.soundFeedback);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700/80 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base leading-tight">
                Trackpad & Input Settings
              </h3>
              <p className="text-xs text-slate-400">
                Customize touch sensitivity, haptics, and gestures
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              triggerClick();
              onClose();
            }}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Settings Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5 text-xs">
          {/* Sensitivity Slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5 text-sky-400" />
                <span>Cursor Sensitivity: {settings.sensitivity.toFixed(1)}x</span>
              </span>
              <span className="text-[11px] text-slate-400">Default: 1.2x</span>
            </div>
            <input
              type="range"
              min="0.4"
              max="3.0"
              step="0.1"
              value={settings.sensitivity}
              onChange={(e) => onUpdateSettings({ sensitivity: parseFloat(e.target.value) })}
              className="w-full accent-sky-400 cursor-pointer"
            />
          </div>

          {/* Acceleration Slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <MousePointer className="w-3.5 h-3.5 text-emerald-400" />
                <span>Acceleration Curve: {settings.acceleration.toFixed(2)}</span>
              </span>
              <span className="text-[11px] text-slate-400">Exponential</span>
            </div>
            <input
              type="range"
              min="1.0"
              max="2.0"
              step="0.05"
              value={settings.acceleration}
              onChange={(e) => onUpdateSettings({ acceleration: parseFloat(e.target.value) })}
              className="w-full accent-emerald-400 cursor-pointer"
            />
          </div>

          {/* Toggle Switches */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
              <div className="flex items-center gap-2">
                <Vibrate className="w-4 h-4 text-sky-400" />
                <div>
                  <div className="font-medium text-slate-200">Haptic Vibration</div>
                  <div className="text-[10px] text-slate-400">Vibrate on clicks, wheel notches, dictation</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.hapticFeedback}
                onChange={(e) => onUpdateSettings({ hapticFeedback: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded"
              />
            </label>

            <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-indigo-400" />
                <div>
                  <div className="font-medium text-slate-200">Tactile Audio Clicks</div>
                  <div className="text-[10px] text-slate-400">Subtle click & tick sound effects</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.soundFeedback}
                onChange={(e) => onUpdateSettings({ soundFeedback: e.target.checked })}
                className="w-4 h-4 accent-indigo-500 rounded"
              />
            </label>

            <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
              <div>
                <div className="font-medium text-slate-200">Tap to Click</div>
                <div className="text-[10px] text-slate-400">Quick 1-finger tap sends Left Click</div>
              </div>
              <input
                type="checkbox"
                checked={settings.tapToClick}
                onChange={(e) => onUpdateSettings({ tapToClick: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded"
              />
            </label>

            <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
              <div>
                <div className="font-medium text-slate-200">Two-Finger Right Click</div>
                <div className="text-[10px] text-slate-400">Tap with two fingers for context menu</div>
              </div>
              <input
                type="checkbox"
                checked={settings.twoFingerRightClick}
                onChange={(e) => onUpdateSettings({ twoFingerRightClick: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded"
              />
            </label>

            <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
              <div>
                <div className="font-medium text-slate-200">Natural / Inverted Scroll</div>
                <div className="text-[10px] text-slate-400">Inverts two-finger scrolling direction</div>
              </div>
              <input
                type="checkbox"
                checked={settings.invertScroll}
                onChange={(e) => onUpdateSettings({ invertScroll: e.target.checked })}
                className="w-4 h-4 accent-sky-500 rounded"
              />
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <button
            onClick={() => {
              triggerClick();
              onResetDefaults();
            }}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Defaults</span>
          </button>

          <button
            onClick={() => {
              triggerClick();
              onClose();
            }}
            className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
