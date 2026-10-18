import { ConnectionStatus, InputEventPayload, MediaAction, SessionType, NowPlaying } from '../types';
import type { AuthAssertion, AuthChallenge } from './authClient';

export type { MediaAction };

// WebSocket.OPEN is not reliably present on the constructor in every runtime
// (shims and wrapped builds can omit the statics), so compare against the
// numeric readyState value from the spec instead.
const WS_OPEN = 1;

// Audio captured before the laptop confirms the session must be held, not
// dropped, or the first word is lost. At 16 kHz mono s16le this is 3 seconds.
const MAX_DICTATION_QUEUE_BYTES = 16000 * 2 * 3;

type EventCallback = (event: InputEventPayload) => void;
type StatusCallback = (status: ConnectionStatus) => void;
type DictationTextCallback = (text: string) => void;
type DictationPartialCallback = (text: string) => void;
type NotifyCallback = (notice: { title: string; body: string }) => void;
type AuthChallengeCallback = (challenge: AuthChallenge) => void;
type MediaNowCallback = (now: NowPlaying) => void;

class LinuxClientService {
  private socket: WebSocket | null = null;
  private listeners: Set<EventCallback> = new Set();
  private statusListeners: Set<StatusCallback> = new Set();
  private dictationTextListeners: Set<DictationTextCallback> = new Set();
  private dictationPartialListeners: Set<DictationPartialCallback> = new Set();
  private notifyListeners: Set<NotifyCallback> = new Set();
  private authChallengeListeners: Set<AuthChallengeCallback> = new Set();
  private mediaNowListeners: Set<MediaNowCallback> = new Set();
  // Last now-playing payload, replayed to a late subscriber (a drawer that was
  // closed when the push arrived) instead of waiting for the next change.
  private lastMediaNow: NowPlaying | null = null;
  private pendingDx = 0;
  private dictationReady = false;
  private dictationWaiter: ((ok: boolean) => void) | null = null;
  private dictationQueue: ArrayBuffer[] = [];
  private dictationQueueBytes = 0;
  private pendingDy = 0;
  private pendingScrollX = 0;
  private pendingScrollY = 0;
  private rafId: number | null = null;
  private pingInterval: number | null = null;
  private pingStart = 0;
  // The daemon's TLS port, learned from `host_info`. Used to pick wss:// vs
  // ws:// from the port we're dialing rather than the page's own scheme.
  private knownHttpsPort = 8443;

  private status: ConnectionStatus = {
    connected: false,
    connecting: false,
    error: null,
    latencyMs: null,
    hostAddress: '',
    sessionType: 'auto',
  };

  constructor() {
    this.scheduleFlush = this.scheduleFlush.bind(this);
    this.installNativeShim();
  }

  /**
   * Expose a tiny, stable bridge for a native shell (the Android app wraps this
   * page in a WebView and has no socket of its own):
   *   window.taildeck.sendMedia('volup' | 'voldown' | ...)  -> hardware keys
   *   window.taildeck.hostInfo                              -> last host_info
   * Purely additive; the browser build ignores it.
   */
  private installNativeShim() {
    if (typeof window === 'undefined') return;
    window.taildeck = {
      ...window.taildeck,
      sendMedia: (action: string) => this.sendMedia(action as MediaAction),
      log: (message: unknown) => console.log('[taildeck-native]', message),
    };
  }

  public onDictationText(callback: DictationTextCallback): () => void {
    this.dictationTextListeners.add(callback);
    return () => {
      this.dictationTextListeners.delete(callback);
    };
  }

  /** Live hypotheses while the phone is still streaming, for preview only. */
  public onDictationPartial(callback: DictationPartialCallback): () => void {
    this.dictationPartialListeners.add(callback);
    return () => {
      this.dictationPartialListeners.delete(callback);
    };
  }

  /** Laptop-initiated notices (e.g. `taildeck-daemon.py notify "..."`). */
  public onNotify(callback: NotifyCallback): () => void {
    this.notifyListeners.add(callback);
    return () => {
      this.notifyListeners.delete(callback);
    };
  }

  /** What the laptop is playing, pushed when it changes. */
  public onMediaNow(callback: MediaNowCallback): () => void {
    this.mediaNowListeners.add(callback);
    if (this.lastMediaNow) {
      try {
        callback(this.lastMediaNow);
      } catch {
        // A listener throwing must not break the subscriber.
      }
    }
    return () => {
      this.mediaNowListeners.delete(callback);
    };
  }

  /** The laptop asking this phone to sign a WebAuthn challenge (unlock). */
  public onAuthChallenge(callback: AuthChallengeCallback): () => void {
    this.authChallengeListeners.add(callback);
    return () => {
      this.authChallengeListeners.delete(callback);
    };
  }

  public getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  public subscribe(cb: EventCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  public subscribeStatus(cb: StatusCallback): () => void {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => this.statusListeners.delete(cb);
  }

  private notifyStatus() {
    const s = this.getStatus();
    this.statusListeners.forEach((cb) => cb(s));
  }

  private notifyLocalEvent(payload: InputEventPayload) {
    this.listeners.forEach((cb) => cb(payload));
  }

  public connect(host: string, sessionType: SessionType = 'auto') {
    this.disconnect();

    const raw = host.trim();
    const pageIsSecure =
      typeof location !== 'undefined' && location.protocol === 'https:';
    const explicitSecureScheme = /^(https|wss):\/\//i.test(raw);
    const explicitPlainScheme = /^(http|ws):\/\//i.test(raw);
    const cleanHost = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^wss?:\/\//i, '');

    // Choose the transport from the port we're dialing, not the page's scheme.
    // The daemon serves plain HTTP on its http port and TLS on its https port,
    // so an https page must reach the http port over ws:// and an http page
    // must reach the https port over wss://. Using the page scheme broke
    // `<host>:8443` (LAN/`.local` https) from an http page and `<host>:8080`
    // from an https page.
    const portMatch = cleanHost.match(/:(\d+)$/);
    const port = portMatch ? Number(portMatch[1]) : null;
    const secure =
      explicitSecureScheme ||
      (!explicitPlainScheme &&
        (port === 443 ||
          port === this.knownHttpsPort ||
          (port === null && pageIsSecure)));
    const wsUrl = `${secure ? 'wss' : 'ws'}://${cleanHost}`;

    this.status = {
      ...this.status,
      hostAddress: cleanHost,
      sessionType,
      connecting: true,
      error: null,
    };
    this.notifyStatus();

    try {
      const ws = new WebSocket(wsUrl);
      this.socket = ws;

      ws.onopen = () => {
        this.status = {
          ...this.status,
          connected: true,
          connecting: false,
          error: null,
        };
        this.notifyStatus();
        this.startPingLoop();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong') {
            const now = performance.now();
            const latency = Math.max(1, Math.round(now - this.pingStart));
            this.status = { ...this.status, latencyMs: latency };
            this.notifyStatus();
          } else if (data.type === 'dictation_ready') {
            this.dictationReady = !!data.ok;
            if (this.dictationReady) {
              this.flushDictationQueue();
            } else {
              this.dropDictationQueue();
            }
            const resolve = this.dictationWaiter;
            this.dictationWaiter = null;
            resolve?.(this.dictationReady);
          } else if (data.type === 'dictation_stopped') {
            this.dictationReady = false;
            this.dropDictationQueue();
          } else if (data.type === 'dictation_partial') {
            const partial = String(data.text ?? '');
            if (partial) {
              this.dictationPartialListeners.forEach((cb) => {
                try {
                  cb(partial);
                } catch {
                  // A listener throwing must not break the socket handler.
                }
              });
            }
          } else if (data.type === 'dictation_text') {
            // The laptop's recogniser finished; this is what it heard.
            const heard = String(data.text ?? '');
            if (heard) {
              this.dictationTextListeners.forEach((cb) => {
                try {
                  cb(heard);
                } catch {
                  // A listener throwing must not break the socket handler.
                }
              });
            }
          } else if (data.type === 'media_now') {
            const now: NowPlaying = {
              active: !!data.active,
              player: typeof data.player === 'string' ? data.player : undefined,
              status: typeof data.status === 'string' ? data.status : undefined,
              title: typeof data.title === 'string' ? data.title : '',
              artist: typeof data.artist === 'string' ? data.artist : '',
              album: typeof data.album === 'string' ? data.album : '',
              lengthMs: Number(data.lengthMs) || 0,
              positionMs: Number(data.positionMs) || 0,
            };
            this.lastMediaNow = now;
            this.mediaNowListeners.forEach((cb) => {
              try {
                cb(now);
              } catch {
                // A listener throwing must not break the socket handler.
              }
            });
          } else if (data.type === 'notify') {
            const notice = {
              title: String(data.title ?? 'TailDeck'),
              body: String(data.body ?? ''),
            };
            this.notifyListeners.forEach((cb) => {
              try {
                cb(notice);
              } catch {
                // A listener throwing must not break the socket handler.
              }
            });
          } else if (data.type === 'auth_challenge') {
            const challenge: AuthChallenge = {
              requestId: String(data.requestId ?? ''),
              challenge: String(data.challenge ?? ''),
              rpId: String(data.rpId ?? ''),
              origin: String(data.origin ?? ''),
              allowCredentials: Array.isArray(data.allowCredentials)
                ? data.allowCredentials.map((c: unknown) => String(c))
                : [],
              timeoutMs: Number(data.timeout) || 60000,
            };
            this.authChallengeListeners.forEach((cb) => {
              try {
                cb(challenge);
              } catch {
                // A listener throwing must not break the socket handler.
              }
            });
          } else if (data.type === 'host_info') {
            if (typeof data.ports?.https === 'number') {
              this.knownHttpsPort = data.ports.https;
            }
            this.status = {
              ...this.status,
              hostOsInfo: {
                hostname: data.hostname || 'linux-laptop',
                os: data.os || 'Linux',
                session: data.session || 'Wayland',
                backend: data.backend || 'uinput',
                addresses: Array.isArray(data.addresses) ? data.addresses : [],
                tailnet: data.tailnet ?? null,
                ports: data.ports,
              },
            };
            this.notifyStatus();

            // Feed a native shell (Android WebView) if one is present, so it can
            // show hostname/session/capabilities without sniffing the socket.
            if (typeof window !== 'undefined') {
              if (window.taildeck) window.taildeck.hostInfo = data;
              try {
                window.TailDeckNative?.onHostInfo(
                  JSON.stringify({
                    hostname: data.hostname || 'linux-laptop',
                    os: data.os || '',
                    session: data.session || 'Wayland',
                    backend: data.backend || '',
                    addresses: Array.isArray(data.addresses) ? data.addresses : [],
                    tailnet: data.tailnet ?? '',
                    ports: data.ports ?? null,
                    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
                    screen: data.screen ?? null,
                  })
                );
              } catch {
                // A broken bridge must never break the socket handler.
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        this.status = {
          ...this.status,
          connecting: false,
          error: 'Connection to Tailscale host failed or refused.',
        };
        this.notifyStatus();
      };

      ws.onclose = () => {
        this.status = {
          ...this.status,
          connected: false,
          connecting: false,
        };
        this.stopPingLoop();
        this.notifyStatus();
      };
    } catch (err) {
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        error: String(err),
      };
      this.notifyStatus();
    }
  }

  public disconnect() {
    this.stopPingLoop();
    // A stale track belongs to the laptop we just left; drop it so the next
    // connection starts from "nothing playing" instead of the last one.
    this.lastMediaNow = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
    this.status = {
      ...this.status,
      connected: false,
      connecting: false,
    };
    this.notifyStatus();
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingInterval = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WS_OPEN) {
        this.pingStart = performance.now();
        this.sendRaw({ type: 'ping', timestamp: Date.now() });
      }
    }, 2500);
  }

  private stopPingLoop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private sendRaw(data: unknown) {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  private scheduleFlush() {
    if (this.pendingDx !== 0 || this.pendingDy !== 0) {
      const dx = Math.round(this.pendingDx);
      const dy = Math.round(this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;

      const payload: InputEventPayload = { type: 'move', dx, dy };
      this.sendRaw(payload);
      this.notifyLocalEvent(payload);
    }

    if (this.pendingScrollX !== 0 || this.pendingScrollY !== 0) {
      const dx = Math.round(this.pendingScrollX);
      const dy = Math.round(this.pendingScrollY);
      this.pendingScrollX = 0;
      this.pendingScrollY = 0;

      const payload: InputEventPayload = { type: 'scroll', dx, dy };
      this.sendRaw(payload);
      this.notifyLocalEvent(payload);
    }

    this.rafId = null;
  }

  // --- Public Input Dispatch Methods ---

  public sendMove(dx: number, dy: number) {
    this.pendingDx += dx;
    this.pendingDy += dy;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.scheduleFlush);
    }
  }

  public sendClick(button: 'left' | 'right' | 'middle', action: 'click' | 'down' | 'up' = 'click') {
    const payload: InputEventPayload = { type: 'click', button, action };
    this.sendRaw(payload);
    this.notifyLocalEvent(payload);
  }

  public sendScroll(dx: number, dy: number) {
    this.pendingScrollX += dx;
    this.pendingScrollY += dy;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.scheduleFlush);
    }
  }

  public sendAppSwitch(direction: 'prev' | 'next') {
    // left = 'prev' (Alt+Shift+Tab), right = 'next' (Alt+Tab)
    const payload: InputEventPayload = { type: 'app_switch', direction };
    this.sendRaw(payload);
    this.notifyLocalEvent(payload);
  }

  /** Ask the laptop to open a recognition session on its local engine. */
  public startDictation(timeoutMs = 4000): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return Promise.resolve(false);
    }
    this.dropDictationQueue();
    const socket = this.socket;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.dictationWaiter === wrapped) this.dictationWaiter = null;
        resolve(false);
      }, timeoutMs);
      const wrapped = (ok: boolean) => {
        window.clearTimeout(timer);
        resolve(ok);
      };
      this.dictationWaiter = wrapped;
      socket.send(JSON.stringify({ type: 'dictation_start' }));
    });
  }

  /** Stream one chunk of 16 kHz mono s16le PCM to the laptop. */
  public sendDictationAudio(pcm: ArrayBuffer) {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    if (!this.dictationReady) {
      // Hold audio captured during the handshake and flush it once the laptop
      // reports the session is ready, so the first word is not lost.
      if (this.dictationQueueBytes + pcm.byteLength > MAX_DICTATION_QUEUE_BYTES) {
        return;
      }
      this.dictationQueue.push(pcm);
      this.dictationQueueBytes += pcm.byteLength;
      return;
    }
    this.sendDictationChunk(pcm);
  }

  private sendDictationChunk(pcm: ArrayBuffer) {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    const bytes = new Uint8Array(pcm);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    this.socket.send(
      JSON.stringify({ type: 'dictation_audio', data: btoa(binary) })
    );
  }

  private flushDictationQueue() {
    const queued = this.dictationQueue;
    this.dictationQueue = [];
    this.dictationQueueBytes = 0;
    for (const pcm of queued) this.sendDictationChunk(pcm);
  }

  private dropDictationQueue() {
    this.dictationQueue = [];
    this.dictationQueueBytes = 0;
  }

  public stopDictation() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: 'dictation_stop' }));
    this.dictationReady = false;
    this.dropDictationQueue();
  }

  public get isDictationReady(): boolean {
    return this.dictationReady;
  }

  public sendTypeText(text: string) {
    const payload: InputEventPayload = { type: 'type_text', text };
    this.sendRaw(payload);
    this.notifyLocalEvent(payload);
  }

  public sendKeyCombo(keys: string[]) {
    const payload: InputEventPayload = { type: 'key_combo', keys };
    this.sendRaw(payload);
    this.notifyLocalEvent(payload);
  }

  /** Transport/volume keys for whatever player the laptop has focused. */
  public sendMedia(action: MediaAction) {
    const payload: InputEventPayload = { type: 'media', action };
    this.sendRaw(payload);
    this.notifyLocalEvent(payload);
  }

  /** The signed WebAuthn assertion that answers an auth_challenge. */
  public sendAuthResponse(assertion: AuthAssertion) {
    this.sendRaw({ type: 'auth_response', ...assertion });
  }
}

export const linuxClient = new LinuxClientService();
