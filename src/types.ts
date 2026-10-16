export type SessionType = 'wayland' | 'x11' | 'auto';

export type InputEventPayload =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'click'; button: 'left' | 'right' | 'middle'; action: 'down' | 'up' | 'click' }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'app_switch'; direction: 'prev' | 'next' } // left (prev = Alt+Shift+Tab) or right (next = Alt+Tab)
  | { type: 'key_combo'; keys: string[] }
  | { type: 'type_text'; text: string }
  | { type: 'ping'; timestamp: number };

export interface ConnectionStatus {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  latencyMs: number | null;
  hostAddress: string;
  sessionType: SessionType;
  hostOsInfo?: {
    hostname: string;
    os: string;
    session: 'Wayland' | 'X11' | 'Unknown';
    backend: string;
    // Reported by the daemon so the app can hand the user every way back to
    // this laptop: LAN addresses (same hotspot only) and the tailnet name.
    addresses?: string[];
    tailnet?: string | null;
    ports?: { http: number; https: number };
  };
}

export interface AppWindow {
  id: string;
  title: string;
  app: string;
  icon: string;
  badge?: string;
}

export interface RemoteSettings {
  sensitivity: number; // 0.5 to 3.0
  acceleration: number; // 1.0 to 2.5
  invertScroll: boolean;
  hapticFeedback: boolean;
  soundFeedback: boolean;
  twoFingerRightClick: boolean;
  tapToClick: boolean;
  wheelSensitivity: number; // pixels of travel per app switch
  tailscaleIp: string;
  autoConnect: boolean; // reconnect to the saved host when the app opens
  connectionAlerts: boolean; // post a system notification when the link comes up or drops
}
