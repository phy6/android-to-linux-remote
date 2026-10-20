// Reactive wrapper around the independent screen desk.
//
// Host metadata (labels, online state) and screen geometry are separate maps:
// `configs` is keyed by laptop address, `screenLayout` is keyed by
// `host::output`. Every physical monitor is its own rectangle, so a laptop's
// screens do not have to sit next to each other. Pass-off is resolved from the
// screen under the pointer, not from a per-laptop ring slot.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SavedLaptop, loadSavedLaptops } from '../services/savedLaptops';
import { fetchLaptopVersion } from '../services/version';
import { fetchMonitors, PointerLocation } from '../services/displaysClient';
import { routesForLaptop, savedIdentityFor } from '../services/hostRoutes';
import {
  backgroundHosts,
  type BackgroundHostStatus,
} from '../services/backgroundHosts';
import {
  HostSpatialConfig,
  Monitor,
  PassOffDirection,
  ScreenHost,
  ScreenLayout,
  ScreenPlacement,
  ScreenPointer,
  arrangeScreens,
  loadScreenLayout,
  loadSpatialConfigs,
  passOffDirections as computePassOffDirections,
  resolvePassOff as computeResolvePassOff,
  saveScreenLayout,
  saveSpatialConfigs,
  screenKey,
  withSavedLaptops,
  withScreenLayout,
} from '../services/spatialLayout';

const PROBE_INTERVAL_MS = 15000;
/** Neighbour geometry changes only on hotplug; one fetch per sheet opening is plenty. */
const NEIGHBOUR_MONITOR_TTL_MS = 60000;

function sameMonitors(a: Monitor[], b: Monitor[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (m, i) =>
        m.output === b[i].output &&
        m.x === b[i].x &&
        m.y === b[i].y &&
        m.width === b[i].width &&
        m.height === b[i].height &&
        (m.rotation ?? 0) === (b[i].rotation ?? 0),
    )
  );
}

export function useSpatialLayout(
  savedLaptops: SavedLaptop[],
  activeHost: string,
  activeInfo?: { id?: string; hostname?: string; addresses?: string[]; tailnet?: string | null },
  /** False when the input socket is idle, so that laptop is kept warm too. */
  activeDriving = true,
  /** True only when the active socket has completed its handshake. */
  activeOnline = false,
) {
  const [configs, setConfigs] = useState<Record<string, HostSpatialConfig>>(() => {
    const { next } = withSavedLaptops(loadSpatialConfigs(), savedLaptops);
    return next;
  });
  const [screenLayout, setScreenLayout] = useState<ScreenLayout>(() => loadScreenLayout());
  /** Warm standby sockets, keyed by saved-laptop identity. These are read-only
   * presence links; `linuxClient` still owns the only input socket. */
  const [backgroundStatuses, setBackgroundStatuses] = useState<
    Record<string, BackgroundHostStatus>
  >(() => backgroundHosts.getStatuses());
  /** Monitors of the active host, for drawing the current desk and mapping the
   * pointer into the logical screen map. */
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  /**
   * Monitors of the *other* saved laptops, keyed by host. Fetched on demand when
   * a sheet opens; never polled. The screen map keeps the last known rectangles
   * when a laptop is offline, so the desk does not collapse.
   */
  const [monitorsByHost, setMonitorsByHost] = useState<Record<string, Monitor[]>>({});
  const neighbourMonitorAtRef = useRef<Map<string, number>>(new Map());
  const neighbourMonitorInFlightRef = useRef<Set<string>>(new Set());

  // The socket can connect through a route that is not the saved identity
  // (hotspot IP, tailnet name, last-good address). Geometry is keyed by the
  // stable saved host, so fold the active route into that identity. Otherwise
  // the same laptop would appear twice and a seam between its own screens would
  // look like a cross-host pass-off.
  const activeIdentity = useMemo(
    () => savedIdentityFor(activeHost, savedLaptops, activeInfo),
    [activeHost, savedLaptops, activeInfo],
  );

  // Warm links are kept for every saved laptop except the one whose socket
  // already drives input. The manager is a singleton so a sheet unmount does
  // not tear the links down; syncing is idempotent.
  useEffect(() => backgroundHosts.subscribe(setBackgroundStatuses), []);
  useEffect(() => {
    // Let the autoconnect effect claim its host first. Opening warm links on
    // the first paint would briefly race a second socket to the laptop that is
    // about to become the active input owner.
    const timer = window.setTimeout(() => {
      backgroundHosts.sync(savedLaptops, activeDriving ? activeIdentity : '');
    }, 250);
    return () => window.clearTimeout(timer);
  }, [savedLaptops, activeIdentity, activeDriving]);

  // Reflect a live background socket in the same metadata the drawer and the
  // spatial canvas already read. `linked` is stronger than an HTTP probe: the
  // laptop has authenticated a websocket and is answering pings.
  useEffect(() => {
    setConfigs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [host, cfg] of Object.entries(prev)) {
        const status = backgroundStatuses[host];
        const linked = !!status?.connected;
        const latency = linked ? status?.latencyMs ?? cfg.latencyMs : cfg.latencyMs;
        const isOnline = linked ? true : cfg.isOnline;
        if (
          cfg.linked !== linked ||
          cfg.isOnline !== isOnline ||
          (linked && cfg.latencyMs !== latency)
        ) {
          next[host] = {
            ...cfg,
            linked,
            isOnline,
            latencyMs: latency,
            lastChecked: linked ? status?.lastSeen ?? cfg.lastChecked : cfg.lastChecked,
          };
          changed = true;
        }
      }
      if (changed) {
        saveSpatialConfigs(next);
        return next;
      }
      return prev;
    });
  }, [backgroundStatuses]);

  // Keep saved laptops synced into the metadata map.
  useEffect(() => {
    setConfigs((prev) => {
      const { next, changed } = withSavedLaptops(prev, savedLaptops);
      if (changed) {
        saveSpatialConfigs(next);
        return next;
      }
      return prev;
    });
  }, [savedLaptops]);

  // The active socket is proof of life even when no REST route is reachable
  // (self-signed TLS, a route only the websocket negotiated, or a transient
  // probe failure). Keep the active metadata row online while it is connected.
  useEffect(() => {
    if (!activeOnline || !activeIdentity) return;
    setConfigs((prev) => {
      const cfg = prev[activeIdentity];
      if (!cfg || cfg.isOnline) return prev;
      const next = {
        ...prev,
        [activeIdentity]: { ...cfg, isOnline: true, lastChecked: Date.now() },
      };
      saveSpatialConfigs(next);
      return next;
    });
  }, [activeOnline, activeIdentity]);

  const validHosts = useMemo(
    () =>
      new Set([
        ...savedLaptops.map((laptop) => laptop.host),
        ...(activeIdentity ? [activeIdentity] : []),
      ]),
    [savedLaptops, activeIdentity],
  );

  const hosts = useMemo<ScreenHost[]>(() => {
    const list: ScreenHost[] = [];
    if (activeIdentity) list.push({ host: activeIdentity, monitors, active: true });
    for (const laptop of savedLaptops) {
      if (laptop.host === activeIdentity) continue;
      list.push({ host: laptop.host, monitors: monitorsByHost[laptop.host] ?? [] });
    }
    return list;
  }, [activeIdentity, monitors, monitorsByHost, savedLaptops]);

  // Reconcile known monitors into the screen map. Existing user positions are
  // preserved; only missing outputs are added and (when the list is
  // authoritative) removed outputs are dropped.
  useEffect(() => {
    setScreenLayout((prev) => {
      const { next, changed } = withScreenLayout(prev, hosts, validHosts, savedLaptops);
      if (changed) {
        saveScreenLayout(next);
        return next;
      }
      return prev;
    });
  }, [hosts, validHosts, screenLayout, savedLaptops]);

  /** Apply a metadata update to one host. */
  const patchHost = useCallback((host: string, patch: Partial<HostSpatialConfig>) => {
    setConfigs((prev) => {
      const existing: HostSpatialConfig =
        prev[host] ?? {
          host,
          name: host,
          shortId: host.slice(0, 2).toUpperCase(),
        };
      const next = { ...prev, [host]: { ...existing, ...patch } };
      saveSpatialConfigs(next);
      return next;
    });
  }, []);

  /** Re-read the active host's monitor layout. Cheap; only the active one. */
  const refreshMonitors = useCallback(async () => {
    if (!activeHost) {
      setMonitors((prev) => (prev.length ? [] : prev));
      return;
    }
    const next = await fetchMonitors(activeHost);
    setMonitors((prev) => (sameMonitors(prev, next) ? prev : next));
  }, [activeHost]);

  /** Fetch one neighbour's own monitor layout, honouring the short TTL. */
  const fetchHostMonitors = useCallback(async (laptop: SavedLaptop, force = false) => {
    // Key by saved identity, not by route: the same laptop may answer on a
    // different address next time, and the UI looks it up by `laptop.host`.
    const key = laptop.host;
    if (!key) return;
    const at = neighbourMonitorAtRef.current.get(key) ?? 0;
    if (!force && Date.now() - at < NEIGHBOUR_MONITOR_TTL_MS) return;
    if (neighbourMonitorInFlightRef.current.has(key)) return;
    neighbourMonitorInFlightRef.current.add(key);
    try {
      // A saved laptop can answer on several addresses, and the most direct
      // one is not always usable from this page (a TLS alt on an http origin,
      // or an address that changed since it was saved). Fall through until a
      // route returns a monitor list.
      let next: Monitor[] = [];
      for (const route of routesForLaptop(laptop)) {
        next = await fetchMonitors(route.host);
        if (next.length > 0) break;
      }
      neighbourMonitorAtRef.current.set(key, Date.now());
      setMonitorsByHost((prev) =>
        sameMonitors(prev[key] ?? [], next) ? prev : { ...prev, [key]: next },
      );
    } finally {
      neighbourMonitorInFlightRef.current.delete(key);
    }
  }, []);

  /**
   * Refresh every saved neighbour's desk, in parallel. Called when a sheet that
   * shows the screen map opens — not from the 15s availability probe, because a
   * neighbour's screens only matter while the user is looking at the layout.
   */
  const refreshNeighbourMonitors = useCallback(
    async (force = false) => {
      const list = loadSavedLaptops().filter((laptop) => laptop.host !== activeIdentity);
      await Promise.allSettled(list.map((laptop) => fetchHostMonitors(laptop, force)));
    },
    [activeIdentity, fetchHostMonitors],
  );

  // Background availability probe across every saved laptop.
  const probeAll = useCallback(async () => {
    void refreshMonitors();
    const list = loadSavedLaptops();
    if (list.length === 0) return;

    for (const laptop of list) {
      // The active websocket is the strongest proof of life. A REST route can
      // be unreachable (self-signed TLS, a scheme the page cannot use) while
      // input is still flowing, so never downgrade the active row.
      if (activeOnline && laptop.host === activeIdentity) continue;

      // A warm link already proves reachability and carries a real ping RTT.
      // Do not let an HTTP/CORS probe downgrade it to offline.
      const background = backgroundHosts.statusFor(laptop.host);
      if (background?.connected) {
        patchHost(laptop.host, {
          isOnline: true,
          linked: true,
          latencyMs: background.latencyMs ?? undefined,
          lastChecked: background.lastSeen ?? Date.now(),
        });
        continue;
      }

      const start = Date.now();
      // Try every known route before declaring the laptop offline. The most
      // direct address can be an https alt that an http origin cannot validate,
      // while the saved http/tailnet route still works.
      let isOnline = false;
      for (const route of routesForLaptop(laptop)) {
        const version = await fetchLaptopVersion(route.host);
        if (version) {
          isOnline = true;
          break;
        }
      }
      patchHost(laptop.host, {
        isOnline,
        linked: false,
        latencyMs: isOnline ? Date.now() - start : undefined,
        lastChecked: Date.now(),
      });
    }
  }, [activeIdentity, activeOnline, patchHost, refreshMonitors]);

  useEffect(() => {
    probeAll();
    const interval = setInterval(probeAll, PROBE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [probeAll]);

  const updateShortId = useCallback(
    (host: string, shortId: string) => patchHost(host, { shortId, shortIdCustom: true }),
    [patchHost],
  );

  /** Commit one screen's logical position after a drag/snap. */
  const updateScreenPosition = useCallback(
    (host: string, output: string, x: number, y: number) => {
      setScreenLayout((prev) => {
        const key = screenKey(host, output);
        const current = prev[key];
        if (!current || (current.x === x && current.y === y)) return prev;
        const next = { ...prev, [key]: { ...current, x, y } };
        saveScreenLayout(next);
        return next;
      });
    },
    [],
  );

  /** Re-lay the current tiles into touching host blocks. This deliberately uses
   * the persisted rectangles rather than clearing and rebuilding from monitors,
   * so it works on Wayland and for offline neighbours with no fresh geometry. */
  const autoArrangeScreens = useCallback(() => {
    const order = [
      ...(activeIdentity ? [activeIdentity] : []),
      ...savedLaptops.map((laptop) => laptop.host).filter((host) => host !== activeIdentity),
    ];
    setScreenLayout((prev) => {
      const next = arrangeScreens(prev, order);
      saveScreenLayout(next);
      return next;
    });
  }, [activeIdentity, savedLaptops]);

  const passOffDirections = useCallback(
    (): PassOffDirection[] => computePassOffDirections(screenLayout, activeIdentity),
    [screenLayout, activeIdentity],
  );

  const resolvePassOff = useCallback(
    (
      direction: PassOffDirection,
      pointer: ScreenPointer | PointerLocation | null,
    ): ScreenPlacement | null =>
      computeResolvePassOff(screenLayout, activeIdentity, direction, pointer, monitors),
    [screenLayout, activeIdentity, monitors],
  );

  const onlineCount = Object.values(configs).filter((c) => c.isOnline).length;
  const linkedCount = Object.values(configs).filter((c) => c.linked).length;

  return {
    activeIdentity,
    configs,
    backgroundStatuses,
    linkedCount,
    screenLayout,
    monitors,
    monitorsByHost,
    refreshNeighbourMonitors,
    updateShortId,
    updateScreenPosition,
    autoArrangeScreens,
    probeAll,
    refreshMonitors,
    passOffDirections,
    resolvePassOff,
    onlineCount,
  };
}
