// Warm standby links to every saved laptop that is not currently driving input.
//
// The active laptop is owned by `linuxClient`: that is the only socket allowed
// to send pointer/key/audio frames. This manager keeps the other saved laptops
// authenticated and answering heartbeats at the same time, so "online" means a
// real websocket and switching hosts does not have to wait for a fresh TLS +
// token handshake. Background sockets deliberately ignore every application
// message except the handshake, pongs, and auth failures.
//
// A background link needs a device token issued by *that* laptop. Tokens are
// origin-scoped in a browser and the native shell switches origins, so a saved
// laptop that has only ever been paired from a different origin can legitimately
// have no token here. In that case the link is reported as "not paired" rather
// than sending another laptop's token to it.

import type { ConnectionStatus } from '../types';
import { getDeviceTokenForHost, rememberDaemonId } from './deviceAuth';
import { routesForLaptop, type HostRoute } from './hostRoutes';
import { parseHostTarget, wsUrl } from './netTarget';
import type { SavedLaptop } from './savedLaptops';

const WS_OPEN = 1;
const PING_INTERVAL_MS = 5000;
/** Two missed heartbeats: TCP may still look open after the phone leaves Wi-Fi. */
const PONG_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** Auth failures are not transient; wait for the user to pair again. */
const WS_PAIRING_REQUIRED = 4401;

export interface BackgroundHostStatus {
  /** Saved-laptop identity, not the live route. */
  host: string;
  connected: boolean;
  connecting: boolean;
  /** False when this origin has no token issued by that laptop. */
  paired: boolean;
  error: string | null;
  latencyMs: number | null;
  lastSeen: number | null;
  hostOsInfo?: ConnectionStatus['hostOsInfo'];
  address?: string;
  transport?: string;
}

type Listener = (statuses: Record<string, BackgroundHostStatus>) => void;

function sameHostInfo(
  a: ConnectionStatus['hostOsInfo'],
  b: ConnectionStatus['hostOsInfo'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.hostname === b.hostname &&
    a.session === b.session &&
    a.backend === b.backend &&
    (a.tailnet ?? null) === (b.tailnet ?? null) &&
    a.ports?.http === b.ports?.http &&
    a.ports?.https === b.ports?.https
  );
}

class BackgroundLink {
  status: BackgroundHostStatus;
  private socket: WebSocket | null = null;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private retryAttempt = 0;
  private pingStart = 0;
  private lastPongAt = 0;
  private stopped = false;
  private needsPairing = false;
  /** Bumped on every open/stop so stale socket handlers cannot resurrect a link. */
  private generation = 0;
  private routeIndex = 0;

  constructor(
    public laptop: SavedLaptop,
    public routes: HostRoute[],
    public token: string,
    private readonly onChange: () => void,
  ) {
    const route = routes[0];
    this.status = {
      host: laptop.host,
      connected: false,
      connecting: false,
      paired: !!token,
      error: token ? null : 'Not paired from this page',
      latencyMs: null,
      lastSeen: null,
      address: route?.host,
      transport: route?.transport,
    };
  }

  get route(): HostRoute | null {
    return this.routes[this.routeIndex] ?? null;
  }

  get routeSignature(): string {
    return this.routes.map((route) => route.host).join(',');
  }

  private advanceRoute() {
    if (this.routes.length > 1) {
      this.routeIndex = (this.routeIndex + 1) % this.routes.length;
    }
  }

  start() {
    this.stopped = false;
    if (!this.token) {
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        paired: false,
        error: 'Not paired from this page',
      };
      this.notify();
      return;
    }
    this.open();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // The socket is already gone.
      }
    }
    this.status = {
      ...this.status,
      connected: false,
      connecting: false,
      latencyMs: null,
    };
  }

  retryNow() {
    if (this.stopped || this.needsPairing || !this.token) return;
    // CONNECTING (0) and OPEN (1) are both live; only CLOSING/CLOSED may retry.
    if (this.socket && this.socket.readyState < 2) return;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.open();
  }

  private open() {
    if (this.stopped || this.needsPairing || !this.token) return;
    const route = this.route;
    if (!route) return;
    const target = parseHostTarget(route.host);
    if (!target) {
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        error: `Not a usable host address: ${route.host}`,
      };
      this.notify();
      this.advanceRoute();
      this.scheduleReconnect();
      return;
    }

    this.clearTimers();
    const generation = ++this.generation;
    const previous = this.socket;
    this.socket = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // Already closed; the generation guard makes its handlers inert.
      }
    }
    // `route.host` is only host:port; the resolver's scheme decides TLS even
    // when the page itself is plain http (for example a tailnet https port).
    const socketUrl = wsUrl({ ...target, scheme: route.scheme });
    this.status = {
      ...this.status,
      connected: false,
      connecting: true,
      error: null,
      address: route.host,
      transport: route.transport,
    };
    this.notify();

    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl);
    } catch (err) {
      this.status = {
        ...this.status,
        connecting: false,
        connected: false,
        error: err instanceof Error ? err.message : 'Could not open the link',
      };
      this.notify();
      this.advanceRoute();
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      if (generation !== this.generation || this.stopped) return;
      this.retryAttempt = 0;
      this.lastPongAt = performance.now();
      // Only the token handshake is sent. No input, media, or REST verbs.
      try {
        ws.send(JSON.stringify({ type: 'hello', token: this.token }));
      } catch {
        // onclose/onerror drive the retry.
      }
      this.startPingLoop(generation);
    };

    ws.onmessage = (event) => {
      if (generation !== this.generation || this.stopped) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;

      if (data.type === 'host_info') {
        const rawPorts = data.ports as { http?: unknown; https?: unknown } | undefined;
        const ports =
          typeof rawPorts?.http === 'number' && typeof rawPorts?.https === 'number'
            ? { http: rawPorts.http, https: rawPorts.https }
            : undefined;
        const info: NonNullable<ConnectionStatus['hostOsInfo']> = {
          id: typeof data.id === 'string' ? data.id : undefined,
          hostname: typeof data.hostname === 'string' ? data.hostname : 'linux-laptop',
          os: typeof data.os === 'string' ? data.os : 'Linux',
          session:
            data.session === 'X11' || data.session === 'Wayland' || data.session === 'Unknown'
              ? data.session
              : 'Unknown',
          backend: typeof data.backend === 'string' ? data.backend : 'uinput',
          addresses: Array.isArray(data.addresses) ? (data.addresses as string[]) : [],
          interfaces: Array.isArray(data.interfaces)
            ? (data.interfaces as NonNullable<ConnectionStatus['hostOsInfo']>['interfaces'])
            : [],
          tailnet: typeof data.tailnet === 'string' ? data.tailnet : null,
          ports,
          certSha256: typeof data.certSha256 === 'string' ? data.certSha256 : null,
          certNames: Array.isArray(data.certNames) ? (data.certNames as string[]) : [],
        };
        if (info.id) {
          // Re-key the token under the daemon's stable id. The next address
          // change can then still find it for this saved identity.
          try {
            rememberDaemonId(this.laptop.host, info.id);
          } catch {
            // Storage may be unavailable; the link still works on this route.
          }
        }
        this.retryAttempt = 0;
        this.status = {
          ...this.status,
          connected: true,
          connecting: false,
          paired: true,
          error: null,
          lastSeen: Date.now(),
          hostOsInfo: sameHostInfo(this.status.hostOsInfo, info)
            ? this.status.hostOsInfo
            : info,
        };
        this.notify();
        return;
      }

      if (data.type === 'pong') {
        const now = performance.now();
        this.lastPongAt = now;
        const latency = Math.max(1, Math.round(now - this.pingStart));
        const changed =
          !this.status.connected ||
          this.status.latencyMs === null ||
          Math.abs(this.status.latencyMs - latency) >= 10;
        this.status = {
          ...this.status,
          connected: true,
          connecting: false,
          paired: true,
          error: null,
          latencyMs: latency,
          lastSeen: Date.now(),
        };
        if (changed) this.notify();
        return;
      }

      if (data.type === 'pair_error') {
        this.needsPairing = true;
        this.stopped = true;
        this.clearTimers();
        this.status = {
          ...this.status,
          connected: false,
          connecting: false,
          paired: false,
          latencyMs: null,
          error:
            typeof data.error === 'string'
              ? data.error
              : 'Pairing code rejected. Pair this laptop again.',
        };
        this.notify();
        try {
          this.socket?.close();
        } catch {
          // Already closing.
        }
      }
    };

    ws.onerror = () => {
      if (generation !== this.generation || this.stopped) return;
      // onclose carries the useful code; do not overwrite a pairing error.
      if (!this.status.error) {
        this.status = { ...this.status, error: 'Link failed' };
        this.notify();
      }
    };

    ws.onclose = (event) => {
      if (generation !== this.generation || this.stopped) return;
      this.socket = null;
      this.clearTimers();
      // A route that authenticated and then dropped is worth retrying as-is
      // before rotating; only a route that never reached host_info advances.
      const wasConnected = this.status.connected;
      const pairingRequired = event.code === WS_PAIRING_REQUIRED;
      if (pairingRequired) this.needsPairing = true;
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        latencyMs: null,
        paired: pairingRequired ? false : this.status.paired,
        error: pairingRequired
          ? 'Device token rejected. Pair this laptop again.'
          : this.status.error,
      };
      this.notify();
      if (!pairingRequired) {
        // If this route never completed a handshake, it is probably stale or
        // unreachable; try the laptop's next known address. A route that had
        // been working is retried first, so a transient drop does not fall
        // through to a slower mDNS attempt.
        if (!wasConnected) this.advanceRoute();
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.needsPairing || !this.token) return;
    if (this.retryTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, Math.min(this.retryAttempt, 4)),
    );
    this.retryAttempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPingLoop(generation: number) {
    this.stopPingLoop();
    this.pingTimer = window.setInterval(() => {
      if (generation !== this.generation || this.stopped) return;
      const ws = this.socket;
      if (!ws || ws.readyState !== WS_OPEN) return;
      const now = performance.now();
      if (this.lastPongAt && now - this.lastPongAt > PONG_TIMEOUT_MS) {
        try {
          ws.close();
        } catch {
          // onclose drives the retry.
        }
        return;
      }
      this.pingStart = now;
      try {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } catch {
        // onclose drives the retry.
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers() {
    this.stopPingLoop();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private notify() {
    this.onChange();
  }
}

class BackgroundHostManager {
  private links = new Map<string, BackgroundLink>();
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof window !== 'undefined') {
      // Mobile browsers throttle timers while hidden; nudge every disconnected
      // link as soon as the page is usable again.
      window.addEventListener('online', () => this.retryDisconnected());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.retryDisconnected();
      });
    }
  }

  /**
   * Reconcile background links with the saved roster. The active identity is
   * excluded because `linuxClient` owns that socket and is the only sender.
   */
  sync(laptops: SavedLaptop[], activeIdentity: string) {
    const desired = new Map<
      string,
      { laptop: SavedLaptop; routes: HostRoute[]; token: string }
    >();

    for (const laptop of laptops) {
      if (!laptop.host || laptop.host === activeIdentity) continue;
      const routes = routesForLaptop(laptop);
      if (routes.length === 0) continue;
      const token =
        getDeviceTokenForHost(laptop.host) ??
        routes.map((route) => getDeviceTokenForHost(route.host)).find(Boolean) ??
        '';
      desired.set(laptop.host, { laptop, routes, token });
    }

    for (const [host, link] of this.links) {
      const want = desired.get(host);
      if (
        !want ||
        link.routeSignature !== want.routes.map((route) => route.host).join(',') ||
        link.token !== want.token ||
        link.laptop.name !== want.laptop.name
      ) {
        link.stop();
        this.links.delete(host);
      }
    }

    for (const [host, want] of desired) {
      if (this.links.has(host)) continue;
      let link: BackgroundLink;
      link = new BackgroundLink(want.laptop, want.routes, want.token, () => {
        if (this.links.get(host) === link) this.publish();
      });
      this.links.set(host, link);
      link.start();
    }

    this.publish();
  }

  getStatuses(): Record<string, BackgroundHostStatus> {
    const copy: Record<string, BackgroundHostStatus> = {};
    for (const [host, link] of this.links) copy[host] = { ...link.status };
    return copy;
  }

  statusFor(host: string): BackgroundHostStatus | null {
    const link = this.links.get(host);
    return link ? { ...link.status } : null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getStatuses());
    return () => {
      this.listeners.delete(listener);
    };
  }

  stopAll() {
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    this.publish();
  }

  private retryDisconnected() {
    for (const link of this.links.values()) link.retryNow();
  }

  private publish() {
    const statuses = this.getStatuses();
    this.listeners.forEach((listener) => {
      try {
        listener(statuses);
      } catch {
        // A subscriber throwing must not break the other links.
      }
    });
  }
}

/** Process-wide warm links. Only one input socket exists, in `linuxClient`. */
export const backgroundHosts = new BackgroundHostManager();
