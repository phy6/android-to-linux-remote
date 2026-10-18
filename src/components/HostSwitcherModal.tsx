import React, { useState } from 'react';
import {
  Laptop,
  RotateCw,
  X,
  Zap,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Edit3,
  Plus,
} from 'lucide-react';
import { ConnectionStatus } from '../types';
import { SavedLaptop } from '../services/savedLaptops';
import {
  HostSpatialConfig,
  SpatialPosition,
  DisplayRotation,
  deriveShortId,
} from '../services/spatialLayout';

interface HostSwitcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionStatus: ConnectionStatus;
  savedLaptops: SavedLaptop[];
  spatialConfigs: Record<string, HostSpatialConfig>;
  onUpdatePosition: (host: string, pos: SpatialPosition) => void;
  onUpdateRotation: (host: string, rot: DisplayRotation) => void;
  onUpdateShortId: (host: string, shortId: string) => void;
  onSelectHost: (host: string) => void;
}

export const HostSwitcherModal: React.FC<HostSwitcherModalProps> = ({
  isOpen,
  onClose,
  connectionStatus,
  savedLaptops,
  spatialConfigs,
  onUpdatePosition,
  onUpdateRotation,
  onUpdateShortId,
  onSelectHost,
}) => {
  const [editingShortIdHost, setEditingShortIdHost] = useState<string | null>(null);
  const [shortIdInput, setShortIdInput] = useState('');
  const [draggedHost, setDraggedHost] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentHost = connectionStatus.hostAddress;

  // Active or primary spatial config
  const activeConfig = spatialConfigs[currentHost] || {
    host: currentHost || 'localhost',
    name: connectionStatus.hostOsInfo?.hostname || currentHost || 'Current Laptop',
    shortId: deriveShortId(connectionStatus.hostOsInfo?.hostname || currentHost, currentHost),
    position: 'center',
    rotation: 0,
    isOnline: connectionStatus.connected,
    latencyMs: connectionStatus.latencyMs ?? undefined,
  };

  const getHostAtPosition = (pos: SpatialPosition): HostSpatialConfig | null => {
    return Object.values(spatialConfigs).find((c) => c.host !== currentHost && c.position === pos) || null;
  };

  const topHost = getHostAtPosition('top');
  const leftHost = getHostAtPosition('left');
  const rightHost = getHostAtPosition('right');
  const bottomHost = getHostAtPosition('bottom');

  const unassignedHosts = savedLaptops.filter(
    (l) => l.host !== currentHost && !['top', 'left', 'right', 'bottom'].includes(spatialConfigs[l.host]?.position)
  );

  const handleStartEditShortId = (hostConfig: HostSpatialConfig) => {
    setEditingShortIdHost(hostConfig.host);
    setShortIdInput(hostConfig.shortId);
  };

  const handleSaveShortId = (host: string) => {
    if (shortIdInput.trim()) {
      onUpdateShortId(host, shortIdInput.trim().toUpperCase());
    }
    setEditingShortIdHost(null);
  };

  const handleRotate = (host: string, currentRotation: DisplayRotation) => {
    const nextRot: DisplayRotation = ((currentRotation + 90) % 360) as DisplayRotation;
    onUpdateRotation(host, nextRot);
  };

  const handleDropToSlot = (targetPosition: SpatialPosition) => {
    if (draggedHost) {
      onUpdatePosition(draggedHost, targetPosition);
      setDraggedHost(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl shadow-black/80 flex flex-col max-h-[90vh] overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Laptop className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Spatial Multi-Host Control</h2>
              <p className="text-xs text-slate-400">
                Position laptops physically to enable edge pass-off & file transfer
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Spatial Matrix Canvas */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="text-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Physical Display Layout
            </span>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Drag or assign laptops around your primary screen. Scroll off an edge to auto pass-off control.
            </p>
          </div>

          {/* 3x3 Spatial Grid */}
          <div className="grid grid-cols-3 gap-3 max-w-lg mx-auto aspect-square items-center justify-center p-2 rounded-2xl bg-slate-950/60 border border-slate-800/80">
            {/* Top Row: Empty / TOP Slot / Empty */}
            <div className="aspect-square" />
            <SlotCard
              position="top"
              label="TOP SCREEN"
              icon={<ArrowUp className="w-3.5 h-3.5" />}
              hostConfig={topHost}
              onSelect={onSelectHost}
              onDrop={handleDropToSlot}
              onRotate={handleRotate}
              onStartEditShortId={handleStartEditShortId}
            />
            <div className="aspect-square" />

            {/* Middle Row: LEFT Slot / CENTER Active Host / RIGHT Slot */}
            <SlotCard
              position="left"
              label="LEFT SCREEN"
              icon={<ArrowLeft className="w-3.5 h-3.5" />}
              hostConfig={leftHost}
              onSelect={onSelectHost}
              onDrop={handleDropToSlot}
              onRotate={handleRotate}
              onStartEditShortId={handleStartEditShortId}
            />

            {/* Center Active Host */}
            <div className="aspect-square flex flex-col items-center justify-center p-3 rounded-2xl bg-sky-950/60 border-2 border-sky-500 shadow-lg shadow-sky-500/10 text-center relative group">
              <div className="absolute top-2 left-2 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[9px] font-bold text-emerald-400 uppercase">Primary</span>
              </div>
              <div
                className="transition-transform duration-300 my-1"
                style={{ transform: `rotate(${activeConfig.rotation}deg)` }}
              >
                <Laptop className="w-8 h-8 text-sky-400" />
              </div>
              <div className="font-bold text-sm text-white tracking-wide mt-1">{activeConfig.shortId}</div>
              <div className="text-[10px] text-slate-300 font-mono truncate max-w-full px-1">
                {activeConfig.name}
              </div>

              {/* Quick Rotation Control */}
              <button
                type="button"
                onClick={() => handleRotate(activeConfig.host, activeConfig.rotation)}
                title="Rotate Screen"
                className="absolute bottom-1.5 right-1.5 p-1 rounded-lg bg-slate-900/80 text-slate-400 hover:text-sky-300 opacity-0 group-hover:opacity-100 transition"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            </div>

            <SlotCard
              position="right"
              label="RIGHT SCREEN"
              icon={<ArrowRight className="w-3.5 h-3.5" />}
              hostConfig={rightHost}
              onSelect={onSelectHost}
              onDrop={handleDropToSlot}
              onRotate={handleRotate}
              onStartEditShortId={handleStartEditShortId}
            />

            {/* Bottom Row: Empty / BOTTOM Slot / Empty */}
            <div className="aspect-square" />
            <SlotCard
              position="bottom"
              label="BOTTOM SCREEN"
              icon={<ArrowDown className="w-3.5 h-3.5" />}
              hostConfig={bottomHost}
              onSelect={onSelectHost}
              onDrop={handleDropToSlot}
              onRotate={handleRotate}
              onStartEditShortId={handleStartEditShortId}
            />
            <div className="aspect-square" />
          </div>

          {/* Unassigned / Additional Laptops List */}
          {unassignedHosts.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-slate-800">
              <span className="text-xs font-semibold text-slate-300 block">Available Saved Laptops</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {unassignedHosts.map((laptop) => {
                  const cfg = spatialConfigs[laptop.host] || {
                    host: laptop.host,
                    name: laptop.name,
                    shortId: deriveShortId(laptop.name, laptop.host),
                    position: 'right',
                    rotation: 0,
                  };
                  return (
                    <div
                      key={laptop.host}
                      draggable
                      onDragStart={() => setDraggedHost(laptop.host)}
                      className="flex items-center justify-between p-3 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition group cursor-grab active:cursor-grabbing"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center font-bold text-xs text-sky-400 shrink-0 border border-slate-800">
                          {cfg.shortId}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white truncate">{laptop.name}</div>
                          <div className="text-[10px] font-mono text-slate-500 truncate">{laptop.host}</div>
                        </div>
                      </div>

                      {/* Quick Slot Assign Buttons */}
                      <div className="flex items-center gap-1 shrink-0">
                        {(['left', 'right', 'top', 'bottom'] as SpatialPosition[]).map((pos) => (
                          <button
                            key={pos}
                            type="button"
                            onClick={() => onUpdatePosition(laptop.host, pos)}
                            title={`Assign to ${pos}`}
                            className="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 text-[10px] font-bold text-slate-400 hover:text-sky-300 uppercase"
                          >
                            {pos[0]}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => onSelectHost(laptop.host)}
                          className="p-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-500 ml-1"
                          title="Swap Now"
                        >
                          <Zap className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Edit Short ID Dialog inline */}
          {editingShortIdHost && (
            <div className="p-4 rounded-2xl bg-slate-950 border border-sky-500/40 space-y-3">
              <span className="text-xs font-semibold text-sky-300 block">Edit Short Identifier (2-3 chars)</span>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={4}
                  value={shortIdInput}
                  onChange={(e) => setShortIdInput(e.target.value.toUpperCase())}
                  className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-sky-500 uppercase w-28"
                  placeholder="e.g. TM"
                />
                <button
                  type="button"
                  onClick={() => handleSaveShortId(editingShortIdHost)}
                  className="px-4 py-1.5 rounded-xl bg-sky-600 text-white text-xs font-semibold hover:bg-sky-500"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingShortIdHost(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-400 text-xs hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface SlotCardProps {
  position: SpatialPosition;
  label: string;
  icon: React.ReactNode;
  hostConfig: HostSpatialConfig | null;
  onSelect: (host: string) => void;
  onDrop: (pos: SpatialPosition) => void;
  onRotate: (host: string, rot: DisplayRotation) => void;
  onStartEditShortId: (cfg: HostSpatialConfig) => void;
}

const SlotCard: React.FC<SlotCardProps> = ({
  position,
  label,
  icon,
  hostConfig,
  onSelect,
  onDrop,
  onRotate,
  onStartEditShortId,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  if (!hostConfig) {
    return (
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => onDrop(position)}
        className="aspect-square flex flex-col items-center justify-center p-2 rounded-2xl border-2 border-dashed border-slate-800 hover:border-slate-700 text-slate-600 hover:text-slate-400 transition text-center group cursor-pointer"
      >
        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider mb-1">
          {icon}
          <span>{label}</span>
        </div>
        <Plus className="w-5 h-5 text-slate-700 group-hover:text-slate-500 mb-1" />
        <span className="text-[9px]">Assign Laptop</span>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(position)}
      className="aspect-square flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition text-center relative group"
    >
      {/* Position Tag & Status Indicator */}
      <div className="absolute top-2 left-2 flex items-center gap-1">
        <span
          className={`w-1.5 h-1.5 rounded-full ${hostConfig.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}`}
        />
        <span className="text-[8px] font-bold text-slate-500 uppercase">{position}</span>
      </div>

      {/* Screen Rotation Preview */}
      <div
        className="transition-transform duration-300 my-1"
        style={{ transform: `rotate(${hostConfig.rotation}deg)` }}
      >
        <Laptop className={`w-7 h-7 ${hostConfig.isOnline ? 'text-slate-300' : 'text-slate-600'}`} />
      </div>

      <div className="font-bold text-xs text-white tracking-wide">{hostConfig.shortId}</div>
      <div className="text-[9px] text-slate-400 font-mono truncate max-w-full px-1">{hostConfig.name}</div>

      {/* Action Buttons overlay */}
      <div className="absolute inset-0 bg-slate-950/90 rounded-2xl flex flex-col items-center justify-center p-2 opacity-0 group-hover:opacity-100 transition duration-150 gap-1.5">
        <button
          type="button"
          onClick={() => onSelect(hostConfig.host)}
          className="w-full py-1.5 px-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-[10px] font-semibold flex items-center justify-center gap-1 shadow-sm"
        >
          <Zap className="w-3 h-3" />
          <span>Swap Now</span>
        </button>

        <div className="flex items-center gap-1 w-full justify-center">
          <button
            type="button"
            onClick={() => onRotate(hostConfig.host, hostConfig.rotation)}
            title="Rotate Display"
            className="p-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
          >
            <RotateCw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => onStartEditShortId(hostConfig)}
            title="Edit Short ID"
            className="p-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
          >
            <Edit3 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
