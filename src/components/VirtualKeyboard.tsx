import React, { useState } from 'react';
import { linuxClient } from '../services/linuxClient';
import { useHaptics } from '../hooks/useHaptics';
import {
  Keyboard as KeyboardIcon,
  X,
  CornerDownLeft,
  Delete,
  Volume2,
  Volume1,
  VolumeX,
  Play,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Send,
} from 'lucide-react';

interface VirtualKeyboardProps {
  isOpen: boolean;
  onClose: () => void;
  hapticsEnabled: boolean;
  soundEnabled: boolean;
}

export const VirtualKeyboard: React.FC<VirtualKeyboardProps> = ({
  isOpen,
  onClose,
  hapticsEnabled,
  soundEnabled,
}) => {
  const { triggerClick } = useHaptics(hapticsEnabled, soundEnabled);
  const [quickInput, setQuickInput] = useState('');

  if (!isOpen) return null;

  const sendKey = (key: string) => {
    triggerClick();
    linuxClient.sendKeyCombo([key]);
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput) return;
    triggerClick();
    linuxClient.sendTypeText(quickInput);
    setQuickInput('');
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 bg-slate-950/95 border-t border-slate-800 p-3 sm:p-4 rounded-t-3xl shadow-2xl backdrop-blur-xl animate-slideUp">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <KeyboardIcon className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-white text-xs sm:text-sm">
            Linux Remote Keyboard & Hotkeys
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg bg-slate-900 text-slate-400 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Quick Text Input Line */}
      <form onSubmit={handleSendText} className="flex gap-2 mb-3">
        <input
          type="text"
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          placeholder="Type here to send directly to laptop..."
          className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono"
        />
        <button
          type="submit"
          disabled={!quickInput}
          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-xl text-xs font-medium flex items-center gap-1 transition"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Type</span>
        </button>
      </form>

      {/* Linux Special Modifiers & Hotkeys */}
      <div className="grid grid-cols-6 gap-1.5 mb-2 text-xs">
        <button
          onClick={() => sendKey('Super_L')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-sky-300 font-bold active:scale-95 text-[11px]"
          title="Super / Windows Key (GNOME Activities / KDE Menu)"
        >
          SUPER
        </button>
        <button
          onClick={() => sendKey('Escape')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 active:scale-95 text-[11px]"
        >
          ESC
        </button>
        <button
          onClick={() => sendKey('Tab')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 active:scale-95 text-[11px]"
        >
          TAB
        </button>
        <button
          onClick={() => sendKey('Control_L')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 active:scale-95 text-[11px]"
        >
          CTRL
        </button>
        <button
          onClick={() => sendKey('Alt_L')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 active:scale-95 text-[11px]"
        >
          ALT
        </button>
        <button
          onClick={() => sendKey('BackSpace')}
          className="py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-rose-300 flex items-center justify-center active:scale-95"
        >
          <Delete className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Navigation Arrows & Media Strip */}
      <div className="flex items-center justify-between gap-2 text-xs">
        {/* Media Controls */}
        <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => sendKey('XF86AudioMute')}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
            title="Mute"
          >
            <VolumeX className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => sendKey('XF86AudioLowerVolume')}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
            title="Volume Down"
          >
            <Volume1 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => sendKey('XF86AudioRaiseVolume')}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
            title="Volume Up"
          >
            <Volume2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => sendKey('XF86AudioPlay')}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
            title="Play / Pause"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Arrow Keys */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => sendKey('Left')}
            className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => sendKey('Up')}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => sendKey('Down')}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={() => sendKey('Right')}
            className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 active:bg-slate-800"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          {/* Enter key */}
          <button
            onClick={() => sendKey('Return')}
            className="px-3 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium flex items-center gap-1 text-xs active:scale-95"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
            <span>ENTER</span>
          </button>
        </div>
      </div>
    </div>
  );
};
