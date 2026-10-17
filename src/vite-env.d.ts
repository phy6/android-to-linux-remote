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

interface Window {
  taildeck?: TailDeckNativeShim;
  TailDeckNative?: { onHostInfo: (json: string) => void };
}
