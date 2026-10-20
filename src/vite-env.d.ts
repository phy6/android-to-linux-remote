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
  /**
   * The shell's roster of laptops it has reached, as a JSON array of
   * `{ host, name, port, isHttps, last }`. Origin-independent, so a host switch
   * cannot strand the list in the origin that was left.
   */
  getSavedHosts?: () => string;
  /** Record a laptop the page just reached (same JSON shape as one roster entry). */
  rememberHost?: (json: string) => void;
  /**
   * The shell's origin-independent device-token store, as JSON. A host switch
   * changes the WebView origin, so without this the next origin cannot open a
   * background link to the laptop it left.
   */
  getDeviceTokens?: () => string;
  /** Persist the whole token store in the shell after a pairing/re-key. */
  saveDeviceTokens?: (json: string) => void;
}

interface Window {
  taildeck?: TailDeckNativeShim;
  TailDeckNative?: TailDeckNativeAppBridge;
  /**
   * Called by the native shell (via evaluateJavascript) from the laptop icon +
   * host name in the status bar. Opens the device info sheet; the spatial
   * canvas is linked one layer below it.
   */
  __taildeckOpenDeviceInfo?: () => void;
  /**
   * Legacy name for the same native status-bar action. Installed shells still
   * call this; keep it aliased so the host identity works without an update.
   */
  __taildeckOpenSpatial?: () => void;
}
