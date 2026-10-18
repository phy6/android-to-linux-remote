// Reactive wrapper around the spatial-layout storage helpers. Owns the config
// map, keeps it synced with the saved-laptop list, and probes every saved host
// for availability so the switcher can show live online/offline state.

import { useCallback, useEffect, useState } from 'react';
import { SavedLaptop, loadSavedLaptops } from '../services/savedLaptops';
import { fetchLaptopVersion } from '../services/version';
import {
  DisplayRotation,
  HostSpatialConfig,
  SpatialPosition,
  deriveShortId,
  loadSpatialConfigs,
  saveSpatialConfigs,
  withSavedLaptops,
} from '../services/spatialLayout';

const PROBE_INTERVAL_MS = 15000;

export function useSpatialLayout(savedLaptops: SavedLaptop[], activeHost: string) {
  const [configs, setConfigs] = useState<Record<string, HostSpatialConfig>>(() => {
    const { next } = withSavedLaptops(loadSpatialConfigs(), savedLaptops, activeHost);
    return next;
  });

  // Keep saved laptops synced into the spatial config map.
  useEffect(() => {
    setConfigs((prev) => {
      const { next, changed } = withSavedLaptops(prev, savedLaptops, activeHost);
      if (changed) {
        saveSpatialConfigs(next);
        return next;
      }
      return prev;
    });
  }, [savedLaptops, activeHost]);

  /** Apply a partial update to one host, deriving the new map from `prev`. */
  const patchHost = useCallback((host: string, patch: Partial<HostSpatialConfig>) => {
    setConfigs((prev) => {
      const existing: HostSpatialConfig =
        prev[host] ?? {
          host,
          name: host,
          shortId: deriveShortId(host, host),
          position: 'right',
          rotation: 0,
        };
      const next = { ...prev, [host]: { ...existing, ...patch } };
      saveSpatialConfigs(next);
      return next;
    });
  }, []);

  // Background availability probe across every saved laptop.
  const probeAll = useCallback(async () => {
    const list = loadSavedLaptops();
    if (list.length === 0) return;

    for (const laptop of list) {
      const start = Date.now();
      try {
        const version = await fetchLaptopVersion(laptop.host);
        const isOnline = !!version;
        patchHost(laptop.host, {
          isOnline,
          latencyMs: isOnline ? Date.now() - start : undefined,
          lastChecked: Date.now(),
        });
      } catch {
        patchHost(laptop.host, { isOnline: false, latencyMs: undefined, lastChecked: Date.now() });
      }
    }
  }, [patchHost]);

  useEffect(() => {
    probeAll();
    const interval = setInterval(probeAll, PROBE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [probeAll]);

  const updatePosition = useCallback(
    (host: string, position: SpatialPosition) => patchHost(host, { position }),
    [patchHost],
  );

  const updateRotation = useCallback(
    (host: string, rotation: DisplayRotation) => patchHost(host, { rotation }),
    [patchHost],
  );

  const updateShortId = useCallback(
    (host: string, shortId: string) => patchHost(host, { shortId }),
    [patchHost],
  );

  /** The host mapped to a given direction relative to the active host, if any. */
  const getHostByDirection = useCallback(
    (direction: 'left' | 'right' | 'top' | 'bottom'): HostSpatialConfig | null =>
      Object.values(configs).find((c) => c.host !== activeHost && c.position === direction) || null,
    [configs, activeHost],
  );

  const onlineCount = Object.values(configs).filter((c) => c.isOnline).length;

  return {
    configs,
    updatePosition,
    updateRotation,
    updateShortId,
    probeAll,
    getHostByDirection,
    onlineCount,
  };
}
