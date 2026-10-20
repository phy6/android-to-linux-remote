export type SessionType = 'wayland' | 'x11' | 'auto';

export type MediaAction =
  | 'playpause'
  | 'next'
  | 'prev'
  | 'stop'
  | 'volup'
  | 'voldown'
  | 'mute'
  | 'yt_playpause'
  | 'yt_replay';

/** What the laptop reports playing, from MPRIS. `active` false when nothing is. */
export interface NowPlaying {
  active: boolean;
  player?: string;
  status?: string;
  title?: string;
  artist?: string;
  album?: string;
  lengthMs?: number;
  positionMs?: number;
}

export type InputEventPayload =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'click'; button: 'left' | 'right' | 'middle'; action: 'down' | 'up' | 'click' }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'app_switch'; direction: 'prev' | 'next' } // left (prev = Alt+Shift+Tab) or right (next = Alt+Tab)
  | { type: 'key_combo'; keys: string[] }
  | { type: 'type_text'; text: string }
  | { type: 'media'; action: MediaAction }
  | { type: 'ping'; timestamp: number };

export interface ConnectionStatus {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  latencyMs: number | null;
  hostAddress: string;
  sessionType: SessionType;
  hostOsInfo?: {
    /** Stable laptop id, independent of address or hostname. */
    id?: string;
    hostname: string;
    os: string;
    session: 'Wayland' | 'X11' | 'Unknown';
    backend: string;
    // Reported by the daemon so the app can hand the user every way back to
    // this laptop: LAN addresses (same hotspot only) and the tailnet name.
    addresses?: string[];
    /** Per-interface reachability, with the transport kind. */
    interfaces?: HostInterface[];
    tailnet?: string | null;
    ports?: { http: number; https: number };
    /** SHA-256 of the leaf certificate, for pinning across address changes. */
    certSha256?: string | null;
    /** Names the certificate actually covers. */
    certNames?: string[];
  };
}

/** One address the laptop says a phone can reach it on. */
export interface HostInterface {
  interface: string;
  address: string;
  transport: 'wifi' | 'usb' | 'bluetooth' | 'ethernet' | 'network' | 'unknown';
  netmask?: string;
  broadcast?: string;
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
  preferLocal: boolean; // try the same-hotspot link first, fall back to Tailscale
  connectionAlerts: boolean; // post a system notification when the link comes up or drops
  buttonScale: number; // global size multiplier for the big thumb controls
  handedness: 'right' | 'left'; // which side the thumb controls and drawer live on
}
