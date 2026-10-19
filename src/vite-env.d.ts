/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

declare const __BUILD_SHA__: string;
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

// Small, stable bridge the native (Android/WebView) shell drives. The phone
// cannot reach the daemon's socket itself, so it calls into the page instead.
interface TailDeckNativeShim {
  sendMedia: (action: string) => void;
  log?: (message: unknown) => void;
  hostInfo?: unknown;
}

interface TailDeckNativeAppBridge {
  onHostInfo: (json: string) => void;
  /** Writes to the shell's log (logcat tag TailDeckJSBridge); diagnostics only. */
  log?: (message: string) => void;
  /**
   * Ask the native shell to load a different laptop's deck. The shell reloads
   * the WebView at that laptop's origin (it owns the deck URL), which is the
   * only way a host switch keeps localStorage and the socket on one origin.
   */
  switchHost?: (host: string, port: number, isHttps: boolean) => void;
}

interface Window {
  taildeck?: TailDeckNativeShim;
  TailDeckNative?: TailDeckNativeAppBridge;
}
