import { ConnectionStatus, InputEventPayload, MediaAction, SessionType, NowPlaying } from '../types';
import type { AuthAssertion, AuthChallenge } from './authClient';
import {
  isMixedContentBlocked,
  parseHostTarget,
  preferHttps,
  targetKey,
  wsUrl,
} from './netTarget';
import { getDeviceToken, rememberDaemonId, saveDeviceToken } from './deviceAuth';

export type { MediaAction };

// WebSocket.OPEN is not reliably present on the constructor in every runtime
// (shims and wrapped builds can omit the statics), so compare against the
// numeric readyState value from the spec instead.
const WS_OPEN = 1;

// Audio captured before the laptop confirms the session must be held, not
// dropped, or the first word is lost. At 16 kHz mono s16le this is 3 seconds.
const MAX_DICTATION_QUEUE_BYTES = 16000 * 2 * 3;
// Same pre-ready buffer for raw recordings: only the handshake window is held.
const MAX_RECORD_QUEUE_BYTES = 16000 * 2 * 3;

type EventCallback = (event: InputEventPayload) => void;
type StatusCallback = (status: ConnectionStatus) => void;
type DictationTextCallback = (text: string) => void;
type DictationPartialCallback = (text: string) => void;
type NotifyCallback = (notice: { title: string; body: string }) => void;
type AuthChallengeCallback = (challenge: AuthChallenge) => void;
type MediaNowCallback = (now: NowPlaying) => void;
type RecordingSavedCallback = (path: string | null, ok: boolean) => void;

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
  private recordReady = false;
  private recordWaiter: ((ok: boolean) => void) | null = null;
  private recordQueue: ArrayBuffer[] = [];
  private recordQueueBytes = 0;
  private recordingSavedListeners: Set<RecordingSavedCallback> = new Set();
  private pendingDy = 0;
  private pendingScrollX = 0;
  private pendingScrollY = 0;
  private rafId: number | null = null;
  private pingInterval: number | null = null;
  private pingStart = 0;
  // The daemon's TLS port, learned from `host_info`. Used to pick wss:// vs
  // ws:// from the port we're dialing rather than the page's own scheme.
  private knownHttpsPort = 8443;
  // A dropped link must recover on its own. The chain that tries alternative
  // addresses opts out, so a dead candidate cannot retry forever; once a host
  // answers, auto-reconnect is switched back on.
  private autoReconnect = true;
  private retryHost = '';
  // A one-time code from a scanned QR. Sent instead of `hello` on the first
  // connection; it is replaced by a device token when the daemon answers
  // `paired`.
  private pendingPairCode: string | null = null;
  private retrySession: SessionType = 'auto';
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  private lastPongAt = 0;

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

  /**
   * Fired once a recording ends. `path` is the WAV the laptop saved (a bare
   * filename under its takes folder), or null if nothing was kept.
   */
  public onRecordingSaved(callback: RecordingSavedCallback): () => void {
    this.recordingSavedListeners.add(callback);
    return () => {
      this.recordingSavedListeners.delete(callback);
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

  public connect(
    host: string,
    sessionType: SessionType = 'auto',
    autoReconnect = true,
    pairCode?: string,
  ) {
    this.closeSocket();
    this.autoReconnect = autoReconnect;
    this.retryHost = host;
    this.retrySession = sessionType;
    // Only a caller that actually has a code should replace it; a route
    // re-resolve or a reconnect must not discard a pending pairing.
    if (pairCode !== undefined) this.setPendingPairCode(pairCode);
    if (!this.pendingPairCode) {
      try {
        const stored = sessionStorage.getItem('taildeck_pair_code');
        if (stored) this.pendingPairCode = stored;
      } catch {
        // Ignore.
      }
    }
    this.clearRetryTimer();

    const target = parseHostTarget(host);
    if (!target) {
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        error: `Not a usable host address: ${host}`,
      };
      this.notifyStatus();
      return;
    }

    // An https page cannot open ws:// (mixed content). Move a plain target to
    // the daemon's TLS port instead of constructing a socket the browser will
    // refuse; a route resolved from the roster should already have done this.
    const usable = isMixedContentBlocked(target, this.knownHttpsPort)
      ? preferHttps(target, this.knownHttpsPort)
      : target;
    const cleanHost = targetKey(usable);
    // The daemon serves plain HTTP on its http port and TLS on its https port.
    // The shared parser lets an explicit scheme or port win; only a bare host
    // follows the page scheme.
    const socketUrl = wsUrl(usable, this.knownHttpsPort);

    // A switch starts with the previous laptop's host_info still in state.
    // Keeping it would let identity folding attribute the new route to the old
    // laptop while the new handshake is still in flight.
    const changedHost = cleanHost !== this.status.hostAddress;
    this.status = {
      ...this.status,
      hostAddress: cleanHost,
      sessionType,
      connecting: true,
      error: null,
      hostOsInfo: changedHost ? undefined : this.status.hostOsInfo,
    };
    this.notifyStatus();

    try {
      const ws = new WebSocket(socketUrl);
      this.socket = ws;

      ws.onopen = () => {
        console.info('[TailDeck] connected', socketUrl, 'autoReconnect=', this.autoReconnect);
        // Authenticate before anything else. A scanned pairing code is spent on
        // this first connection; later ones use the stored device token.
        const pairCode = this.pendingPairCode;
        const token = getDeviceToken(this.retryHost || host);
        try {
          if (pairCode) {
            ws.send(JSON.stringify({ type: 'pair', code: pairCode, label: 'phone' }));
            this.clearPairCode();
          } else if (token) {
            ws.send(JSON.stringify({ type: 'hello', token }));
          }
        } catch {
          // onerror/onclose drive the retry.
        }
        this.status = {
          ...this.status,
          connected: true,
          connecting: false,
          error: null,
        };
        this.retryAttempt = 0;
        this.lastPongAt = performance.now();
        this.notifyStatus();
        this.startPingLoop();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'paired') {
            const token = typeof data.token === 'string' ? data.token : '';
            if (token) {
              saveDeviceToken(this.retryHost || host, token);
              this.clearPairCode();
              console.info('[TailDeck] paired with', data.label || 'laptop');
            }
          } else if (data.type === 'pair_error') {
            this.clearPairCode();
            // A bad/expired code cannot succeed on retry.
            this.autoReconnect = false;
            this.status = {
              ...this.status,
              connected: false,
              connecting: false,
              error: String(data.error || 'Pairing code rejected. Show a new code on the laptop.'),
            };
            this.notifyStatus();
          } else if (data.type === 'pong') {
            const now = performance.now();
            this.lastPongAt = now;
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
          } else if (data.type === 'record_ready') {
            this.recordReady = !!data.ok;
            if (this.recordReady) {
              this.flushRecordQueue();
            } else {
              this.dropRecordQueue();
            }
            const resolve = this.recordWaiter;
            this.recordWaiter = null;
            resolve?.(this.recordReady);
          } else if (data.type === 'record_stopped') {
            this.recordReady = false;
            this.dropRecordQueue();
            const path = typeof data.path === 'string' ? data.path : null;
            this.recordingSavedListeners.forEach((cb) => {
              try {
                cb(path, path !== null);
              } catch {
                // A listener throwing must not break the socket handler.
              }
            });
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
            if (typeof data.id === 'string' && data.id) {
              // Re-key the token under the daemon's stable id, so the same
              // laptop on another route still finds it.
              rememberDaemonId(this.retryHost || host, data.id);
            }
            this.status = {
              ...this.status,
              hostOsInfo: {
                id: typeof data.id === 'string' ? data.id : undefined,
                hostname: data.hostname || 'linux-laptop',
                os: data.os || 'Linux',
                session: data.session || 'Wayland',
                backend: data.backend || 'uinput',
                addresses: Array.isArray(data.addresses) ? data.addresses : [],
                interfaces: Array.isArray(data.interfaces) ? data.interfaces : [],
                tailnet: data.tailnet ?? null,
                ports: data.ports,
                certSha256: typeof data.certSha256 === 'string' ? data.certSha256 : null,
                certNames: Array.isArray(data.certNames) ? data.certNames : [],
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
                    id: data.id || '',
                    hostname: data.hostname || 'linux-laptop',
                    os: data.os || '',
                    session: data.session || 'Wayland',
                    backend: data.backend || '',
                    addresses: Array.isArray(data.addresses) ? data.addresses : [],
                    interfaces: Array.isArray(data.interfaces) ? data.interfaces : [],
                    tailnet: data.tailnet ?? '',
                    ports: data.ports ?? null,
                    certSha256: data.certSha256 ?? null,
                    certNames: Array.isArray(data.certNames) ? data.certNames : [],
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
          error: `Could not reach ${cleanHost}. Check that the laptop is on the same link.`,
        };
        this.notifyStatus();
      };

      ws.onclose = (event) => {
        // A replaced socket (host switch, retry) must not report for the one we
        // are now using, or it would schedule a retry against the new host.
        if (this.socket !== ws) {
          console.info('[TailDeck] stale socket closed', socketUrl);
          return;
        }
        // 4401 is the daemon saying it does not know this device. Retrying
        // would only loop; the phone must scan a fresh pairing code.
        if (event?.code === 4401) {
          this.autoReconnect = false;
          this.clearPairCode();
        }
        console.info('[TailDeck] socket closed', socketUrl, 'autoReconnect=', this.autoReconnect, 'retryHost=', this.retryHost);
        this.status = {
          ...this.status,
          connected: false,
          connecting: false,
          error:
            event?.code === 4401
              ? 'This laptop needs pairing. Show a code on the laptop and scan it.'
              : this.status.error,
        };
        this.stopPingLoop();
        this.notifyStatus();
        this.scheduleReconnect();
      };
    } catch (err) {
      this.status = {
        ...this.status,
        connected: false,
        connecting: false,
        error: String(err),
      };
      this.notifyStatus();
      this.scheduleReconnect();
    }
  }

  /** True while a scanned/typed pairing code is still waiting to be spent. */
  public hasPendingPairCode(): boolean {
    if (this.pendingPairCode) return true;
    try {
      return !!sessionStorage.getItem('taildeck_pair_code');
    } catch {
      return false;
    }
  }

  /** Supply a one-time code from a scanned pairing QR before connecting. */
  public setPendingPairCode(code?: string) {
    this.pendingPairCode = code?.trim() || null;
    try {
      // The native shell reloads the WebView when switching laptops, so keep
      // the code across that navigation until it is spent or rejected.
      if (this.pendingPairCode) sessionStorage.setItem('taildeck_pair_code', this.pendingPairCode);
      else sessionStorage.removeItem('taildeck_pair_code');
    } catch {
      // Private mode / disabled storage: the in-memory value still works.
    }
  }

  private clearPairCode() {
    this.pendingPairCode = null;
    try {
      sessionStorage.removeItem('taildeck_pair_code');
    } catch {
      // Ignore.
    }
  }

  /** Turn retrying on or off; a manual disconnect turns it off. */
  public setAutoReconnect(enabled: boolean) {
    console.info('[TailDeck] autoReconnect=', enabled);
    this.autoReconnect = enabled;
    if (!enabled) this.clearRetryTimer();
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleReconnect() {
    if (!this.autoReconnect || !this.retryHost || this.retryTimer !== null) return;
    const base = Math.min(15000, 1000 * 2 ** Math.min(this.retryAttempt, 4));
    const delay = base + Math.round(Math.random() * 400);
    this.retryAttempt += 1;
    console.info('[TailDeck] scheduling retry', delay, 'attempt', this.retryAttempt, 'host', this.retryHost);
    this.status = {
      ...this.status,
      error: this.retryHost
        ? `Reconnecting to ${this.retryHost} (attempt ${this.retryAttempt})…`
        : this.status.error,
    };
    this.notifyStatus();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.autoReconnect) return;
      console.info('[TailDeck] retrying', this.retryHost);
      this.connect(this.retryHost, this.retrySession, true);
    }, delay);
  }

  private closeSocket() {
    this.stopPingLoop();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
  }

  public disconnect() {
    this.autoReconnect = false;
    this.clearRetryTimer();
    this.retryAttempt = 0;
    this.clearPairCode();
    this.closeSocket();
    // A stale track belongs to the laptop we just left; drop it so the next
    // connection starts from "nothing playing" instead of the last one.
    this.lastMediaNow = null;
    // A recording session lived on the socket we just left; do not let the next
    // connection stream into it before it says record_ready.
    this.recordReady = false;
    this.dropRecordQueue();
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
        const now = performance.now();
        // Two missed pongs means the link is dead even if TCP has not noticed
        // (a phone leaving the hotspot often looks like this).
        if (this.lastPongAt && now - this.lastPongAt > 10000) {
          try {
            this.socket.close();
          } catch {
            // onclose drives the retry.
          }
          return;
        }
        this.pingStart = now;
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

  public cancelDictation() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: 'dictation_cancel' }));
    this.dictationReady = false;
    this.dropDictationQueue();
  }

  public get isDictationReady(): boolean {
    return this.dictationReady;
  }

  /**
   * Ask the laptop to open a WAV on disk and accept raw phone audio. Unlike
   * dictation this never touches the recogniser: the PCM is written as-is, for
   * keeping. `label` only affects the filename.
   */
  public startRecording(sampleRate = 16000, label = '', timeoutMs = 4000): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return Promise.resolve(false);
    }
    this.dropRecordQueue();
    const socket = this.socket;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.recordWaiter === wrapped) this.recordWaiter = null;
        resolve(false);
      }, timeoutMs);
      const wrapped = (ok: boolean) => {
        window.clearTimeout(timer);
        resolve(ok);
      };
      this.recordWaiter = wrapped;
      socket.send(JSON.stringify({ type: 'record_start', sampleRate, label }));
    });
  }

  /** Stream one chunk of mono s16le PCM to the laptop's recording. */
  public sendRecordingAudio(pcm: ArrayBuffer) {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    if (!this.recordReady) {
      // Hold audio captured before the laptop confirms, or the start is clipped.
      if (this.recordQueueBytes + pcm.byteLength > MAX_RECORD_QUEUE_BYTES) return;
      this.recordQueue.push(pcm);
      this.recordQueueBytes += pcm.byteLength;
      return;
    }
    this.sendRecordingChunk(pcm);
  }

  private sendRecordingChunk(pcm: ArrayBuffer) {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    const bytes = new Uint8Array(pcm);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    this.socket.send(
      JSON.stringify({ type: 'record_audio', data: btoa(binary) })
    );
  }

  private flushRecordQueue() {
    const queued = this.recordQueue;
    this.recordQueue = [];
    this.recordQueueBytes = 0;
    for (const pcm of queued) this.sendRecordingChunk(pcm);
  }

  private dropRecordQueue() {
    this.recordQueue = [];
    this.recordQueueBytes = 0;
  }

  /** Finalise the WAV; the laptop reports the saved filename via onRecordingSaved. */
  public stopRecording() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: 'record_stop' }));
    this.recordReady = false;
    this.dropRecordQueue();
  }

  /** Abandon the recording; the laptop deletes the partial file. */
  public cancelRecording() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: 'record_cancel' }));
    this.recordReady = false;
    this.dropRecordQueue();
  }

  public get isRecordingReady(): boolean {
    return this.recordReady;
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
