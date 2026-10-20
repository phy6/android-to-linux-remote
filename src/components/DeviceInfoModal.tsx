import React from 'react';
import {
  Activity,
  ArrowRight,
  Fingerprint,
  Laptop,
  Monitor,
  Network,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { ConnectionStatus } from '../types';
import { SavedLaptop } from '../services/savedLaptops';
import { HostSpatialConfig, Monitor as HostMonitor, deriveShortId } from '../services/spatialLayout';
import { bestLaptopRoute, routeTransportLabel, savedIdentityFor } from '../services/hostRoutes';
import { IS_LOCAL_MODE, describeRoute } from '../services/localMode';

export interface DeviceInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionStatus: ConnectionStatus;
  savedLaptops: SavedLaptop[];
  spatialConfigs: Record<string, HostSpatialConfig>;
  /** Monitors of the active laptop, for the screen line. */
  monitors: HostMonitor[];
  /** Each other laptop's own monitors, fetched when this sheet opens. */
  neighbourMonitors?: Record<string, HostMonitor[]>;
  /** Push the spatial multi-host canvas one layer down. */
  onOpenSpatial: () => void;
  /** Open the xrandr screen-arrangement editor for the connected laptop. */
  onOpenDisplays: () => void;
  onSelectHost?: (host: string) => void;
}

/** One label/value line, kept compact so the sheet stays thumb-sized. */
const InfoRow: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-start gap-2.5 py-2 border-b border-slate-800/70 last:border-b-0">
    <span className="mt-0.5 text-slate-500 shrink-0">{icon}</span>
    <span className="text-[11px] text-slate-500 shrink-0 w-20">{label}</span>
    <span className="text-[11px] text-slate-200 min-w-0 flex-1 break-words">{value}</span>
  </div>
);

/**
 * The device info sheet: what the deck is currently driving, opened from the
 * laptop icon + host name at the uppermost left. The spatial canvas lives one
 * layer below this sheet, behind the "Spatial layout" link, so the common
 * question ("what am I connected to?") does not require the full layout editor.
 */
export const DeviceInfoModal: React.FC<DeviceInfoModalProps> = ({
  isOpen,
  onClose,
  connectionStatus,
  savedLaptops,
  spatialConfigs,
  monitors,
  neighbourMonitors = {},
  onOpenSpatial,
  onOpenDisplays,
  onSelectHost,
}) => {
  if (!isOpen) return null;

  const connectedHost = connectionStatus.hostAddress;
  const info = connectionStatus.hostOsInfo;
  // The socket may use a hotspot/tailnet route that differs from the saved
  // identity. Identity drives config rows, siblings and labels; the route row
  // still shows the address the socket actually reached.
  const host = savedIdentityFor(connectedHost, savedLaptops, info);
  const cfg = host ? spatialConfigs[host] : undefined;
  const name = cfg?.name || info?.hostname || savedLaptops.find((l) => l.host === host)?.name || host;
  const shortId = cfg?.shortId || deriveShortId(name || host, host);
  const route = describeRoute(connectedHost, IS_LOCAL_MODE, connectionStatus.connected);
  const others = savedLaptops.filter((l) => l.host !== host);
  // The active laptop is online by virtue of this socket even when the
  // background HTTP probe cannot reach it (CORS/loopback route mismatch).
  const online = new Set([
    ...Object.values(spatialConfigs)
      .filter((c) => c.isOnline)
      .map((c) => c.host),
    ...(connectionStatus.connected && host ? [host] : []),
  ]).size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Device information"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[85dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-slate-950 border border-slate-800 shadow-2xl shadow-black/60 animate-fadeIn"
      >
        {/* Header: the same laptop icon + name as the host identity. */}
        <div className="flex items-start gap-3 p-4 border-b border-slate-800">
          <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-300 shrink-0">
            <Laptop className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white truncate">{name || 'No laptop'}</h2>
              <span className="text-[10px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
                {shortId}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-mono truncate">
              {connectedHost || 'not connected'}
            </p>
          </div>
          <span
            className={`mt-1 flex items-center gap-1 text-[10px] font-semibold shrink-0 ${
              connectionStatus.connected ? 'text-emerald-400' : 'text-slate-500'
            }`}
          >
            {connectionStatus.connected ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            {connectionStatus.connected ? 'Online' : connectionStatus.connecting ? 'Connecting' : 'Offline'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close device information"
            className="p-1.5 rounded-xl bg-slate-900 text-slate-400 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Active link facts. */}
          <div className="rounded-2xl bg-slate-900/70 border border-slate-800 px-3 py-1">
            <InfoRow icon={<Network className="w-3.5 h-3.5" />} label="Route" value={route} />
            <InfoRow
              icon={<Activity className="w-3.5 h-3.5" />}
              label="Latency"
              value={
                connectionStatus.latencyMs != null
                  ? `${Math.round(connectionStatus.latencyMs)} ms`
                  : '—'
              }
            />
            <InfoRow
              icon={<Monitor className="w-3.5 h-3.5" />}
              label="Session"
              value={
                info
                  ? `${info.os || 'Linux'} · ${info.session || 'Unknown'} · ${info.backend || 'backend unknown'}`
                  : connectionStatus.connected
                    ? 'Not reported yet'
                    : '—'
              }
            />
            <InfoRow
              icon={<Monitor className="w-3.5 h-3.5" />}
              label="Screens"
              value={
                monitors.length ? (
                  <span className="flex flex-wrap gap-1">
                    {monitors.map((m) => (
                      <span
                        key={m.output}
                        className="inline-flex items-center gap-1 rounded-md bg-slate-950 border border-slate-800 px-1.5 py-0.5 text-[10px] font-mono"
                      >
                        <Monitor
                          className="w-2.5 h-2.5 text-sky-300 shrink-0"
                          style={{ transform: `rotate(${m.rotation ?? 0}deg)` }}
                        />
                        {m.output} {m.width}×{m.height}
                      </span>
                    ))}
                  </span>
                ) : (
                  'Desk unknown'
                )
              }
            />
            <InfoRow
              icon={<Fingerprint className="w-3.5 h-3.5" />}
              label="Input"
              value={
                connectedHost && connectionStatus.connected
                  ? 'Active — this laptop receives the deck'
                  : 'Not connected'
              }
            />
            {info?.tailnet && (
              <InfoRow icon={<Network className="w-3.5 h-3.5" />} label="Tailnet" value={info.tailnet} />
            )}
          </div>

          {/* The spatial canvas, one layer below this sheet. */}
          <button
            type="button"
            onClick={onOpenSpatial}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-2xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] text-white transition"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Laptop className="w-4 h-4" />
              Spatial layout
            </span>
            <span className="flex items-center gap-1 text-[11px] text-sky-100/90">
              {online} online
              <ArrowRight className="w-4 h-4" />
            </span>
          </button>

          {/* Each physical screen is a draggable, rotatable icon here. */}
          <button
            type="button"
            onClick={onOpenDisplays}
            disabled={!connectionStatus.connected}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 active:scale-[0.99] text-white transition disabled:opacity-50"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Monitor className="w-4 h-4 text-sky-300" />
              Arrange screens
            </span>
            <span className="flex items-center gap-1 text-[11px] text-slate-400">
              {monitors.length ? `${monitors.length} screen${monitors.length === 1 ? '' : 's'}` : 'Desk unknown'}
              <ArrowRight className="w-4 h-4" />
            </span>
          </button>

          {/* Other known laptops: one tap to switch without opening the layout. */}
          {others.length > 0 && (
            <div className="space-y-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Other laptops
              </span>
              {others.map((laptop) => {
                const otherCfg = spatialConfigs[laptop.host];
                const otherRoute = bestLaptopRoute(laptop);
                return (
                  <button
                    key={laptop.host}
                    type="button"
                    onClick={() => {
                      onSelectHost?.(laptop.host);
                      onClose();
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 active:scale-[0.99] text-left transition"
                  >
                    <span className="w-8 h-8 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center text-[10px] font-bold text-sky-300 shrink-0">
                      {otherCfg?.shortId || deriveShortId(laptop.name, laptop.host)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-slate-100 truncate">
                        {laptop.name || laptop.host}
                      </span>
                      <span className="block text-[10px] font-mono text-slate-500 truncate">
                        {otherRoute?.host ?? laptop.host}
                      </span>
                      {(neighbourMonitors[laptop.host]?.length ?? 0) > 0 && (
                        <span className="block text-[9px] text-sky-400/80 truncate">
                          {neighbourMonitors[laptop.host]
                            .map((m) => `${m.output} ${m.width}×${m.height}`)
                            .join(' · ')}
                        </span>
                      )}
                    </span>
                    {otherRoute && (
                      <span className="text-[8px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 shrink-0">
                        {routeTransportLabel(otherRoute)}
                      </span>
                    )}
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        otherCfg?.isOnline ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
