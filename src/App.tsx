import { useState, useEffect } from 'react';
import { linuxClient } from './services/linuxClient';
import { ConnectionStatus, RemoteSettings } from './types';
import { HorizontalScrollWheel } from './components/HorizontalScrollWheel';
import { Trackpad } from './components/Trackpad';
import { BottomClickButtons } from './components/BottomClickButtons';
import { FloatingDictationButton } from './components/FloatingDictationButton';
import { DictationModal } from './components/DictationModal';
import { SideMenuDrawer } from './components/SideMenuDrawer';
import { LinuxSimulator } from './components/LinuxSimulator';

const DEFAULT_SETTINGS: RemoteSettings = {
  sensitivity: 1.2,
  acceleration: 1.25,
  invertScroll: false,
  hapticFeedback: true,
  soundFeedback: true,
  twoFingerRightClick: true,
  tapToClick: true,
  wheelSensitivity: 26,
  tailscaleIp: '192.0.2.10:8080',
  tailscalePort: 8080,
  useSimulator: true,
};

export default function App() {
  const [settings, setSettings] = useState<RemoteSettings>(() => {
    try {
      const saved = localStorage.getItem('taildeck_settings');
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
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

      {/* Simple Floating Circular Dictation Button (Freely Draggable & Droppable anywhere) */}
      <FloatingDictationButton
        onTriggerDictation={() => setIsDictationOpen(true)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
      />

      {/* Voice Dictation Input Sheet */}
      <DictationModal
        isOpen={isDictationOpen}
        onClose={() => setIsDictationOpen(false)}
        hapticsEnabled={settings.hapticFeedback}
        soundEnabled={settings.soundFeedback}
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
