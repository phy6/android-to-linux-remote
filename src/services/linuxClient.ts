import { ConnectionStatus, InputEventPayload, SessionType } from '../types';

// WebSocket.OPEN is not reliably present on the constructor in every runtime
// (shims and wrapped builds can omit the statics), so compare against the
// numeric readyState value from the spec instead.
const WS_OPEN = 1;

type EventCallback = (event: InputEventPayload) => void;
type StatusCallback = (status: ConnectionStatus) => void;

class LinuxClientService {
  private socket: WebSocket | null = null;
  private listeners: Set<EventCallback> = new Set();
  private statusListeners: Set<StatusCallback> = new Set();
  private pendingDx = 0;
  private dictationReady = false;
  private dictationWaiter: ((ok: boolean) => void) | null = null;
  private pendingDy = 0;
  private pendingScrollX = 0;
  private pendingScrollY = 0;
  private rafId: number | null = null;
  private pingInterval: number | null = null;
  private pingStart = 0;

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
    const explicitSecure = /^wss:\/\//i.test(raw);
    const cleanHost = raw
      .replace(/^https:\/\//i, '')
      .replace(/^wss:\/\//i, '')
      .replace(/^ws:\/\//i, '')
      .replace(/^http:\/\//i, '');
    const wsUrl = `${pageIsSecure || explicitSecure ? 'wss' : 'ws'}://${cleanHost}`;

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
            const resolve = this.dictationWaiter;
            this.dictationWaiter = null;
            resolve?.(this.dictationReady);
          } else if (data.type === 'dictation_stopped') {
            this.dictationReady = false;
          } else if (data.type === 'host_info') {
            this.status = {
              ...this.status,
              hostOsInfo: {
                hostname: data.hostname || 'linux-laptop',
                os: data.os || 'Linux',
                session: data.session || 'Wayland',
                backend: data.backend || 'uinput',
              },
            };
            this.notifyStatus();
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
    if (!this.dictationReady) return;
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

  public stopDictation() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: 'dictation_stop' }));
    this.dictationReady = false;
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
}

export const linuxClient = new LinuxClientService();
