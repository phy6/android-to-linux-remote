import React from 'react';
import { Monitor as MonitorIcon, X } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { SavedLaptop } from '../services/savedLaptops';
import { HostSpatialConfig, Monitor, ScreenLayout } from '../services/spatialLayout';
import { SpatialHostPanel } from './SpatialHostPanel';

export interface SpatialLayoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionStatus: ConnectionStatus;
  savedLaptops: SavedLaptop[];
  spatialConfigs: Record<string, HostSpatialConfig>;
  /** Every physical screen, keyed by `host::output`. */
  screenLayout: ScreenLayout;
  /** Monitors of the active laptop, for pointer mapping and live geometry. */
  monitors: Monitor[];
  /** Each neighbour's monitors, fetched when the sheet opens. */
  monitorsByHost: Record<string, Monitor[]>;
  onUpdateShortId: (host: string, shortId: string) => void;
  onUpdateScreenPosition: (host: string, output: string, x: number, y: number) => void;
  onAutoArrange: () => void;
  onSelectHost: (host: string) => void;
  /** Open the screen-arrangement editor for the connected laptop. */
  onOpenDisplays?: () => void;
}

/**
 * The independent screen desk as its own layer.
 *
 * It used to be a ring of laptops around a centre card. It is now a free canvas:
 * every monitor from every saved laptop is its own draggable rectangle, matching
 * the single-laptop xrandr editor. Screens can be snapped together in any order,
 * including two of one laptop's screens separated by another laptop's screen.
 */
export const SpatialLayoutModal: React.FC<SpatialLayoutModalProps> = ({
  isOpen,
  onClose,
  connectionStatus,
  savedLaptops,
  spatialConfigs,
  screenLayout,
  monitors,
  monitorsByHost,
  onUpdateShortId,
  onUpdateScreenPosition,
  onAutoArrange,
  onSelectHost,
  onOpenDisplays,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Spatial layout"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-slate-950 border border-slate-800 shadow-2xl shadow-black/60 animate-fadeIn"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">Spatial layout</h2>
            <p className="text-[11px] text-slate-500 truncate">
              Every screen is independent. Drag screens together to make copy edges.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onOpenDisplays && (
              <button
                type="button"
                onClick={onOpenDisplays}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-[11px] font-semibold hover:border-sky-500 hover:text-white transition"
              >
                <MonitorIcon className="w-3.5 h-3.5 text-sky-300" />
                Arrange screens
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close spatial layout"
              className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <SpatialHostPanel
            connectionStatus={connectionStatus}
            savedLaptops={savedLaptops}
            spatialConfigs={spatialConfigs}
            screenLayout={screenLayout}
            monitors={monitors}
            monitorsByHost={monitorsByHost}
            onUpdateShortId={onUpdateShortId}
            onUpdateScreenPosition={onUpdateScreenPosition}
            onAutoArrange={onAutoArrange}
            onOpenDisplays={onOpenDisplays}
            onSelectHost={(host) => {
              onSelectHost(host);
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
};
