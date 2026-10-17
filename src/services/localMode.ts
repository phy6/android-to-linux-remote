// When the laptop daemon serves the app over http on the hotspot, the page
// origin *is* the laptop. In that case the browser can talk to it over ws://
// on the same host, which keeps audio and input on the local link instead of
// hairpin through the carrier, and works with mobile data switched off.
//
// An https page is not allowed to open a ws:// socket (mixed content), so this
// mode only exists for the http-served copy. The Pages copy is unaffected.

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
const HOSTED = /(^|\.)github\.io$/i;

// The native Android shell loads the deck from the daemon itself. Over a USB
// `adb reverse` tunnel the daemon answers on 127.0.0.1, so a loopback origin is
// the laptop there — not the hosted copy. The shell marks the page with this
// query flag and injects window.TailDeckNative.
export const NATIVE_MARKER = 'td_native';

/** True when the page is running inside the native Android shell. */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { TailDeckNative?: unknown }).TailDeckNative) return true;
  if (typeof location === 'undefined') return false;
  try {
    return new URLSearchParams(location.search).has(NATIVE_MARKER);
  } catch {
    return false;
  }
}

export function localHost(): string {
  if (typeof location === 'undefined') return '';
  const { protocol, hostname, host } = location;
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  if (HOSTED.test(hostname)) return '';
  if (LOOPBACK.test(hostname) && !isNativeShell()) return '';
  return host;
}

export const LOCAL_HOST: string = localHost();

/** True when the app itself was loaded from the laptop daemon. */
export const IS_LOCAL_MODE: boolean = LOCAL_HOST !== '';

/** Human-readable description of how the phone is currently reaching the laptop. */
export function describeRoute(host: string, localMode: boolean, connected: boolean): string {
  if (!host) return 'no address set';
  if (!connected) return 'not connected';
  if (localMode) return 'Local — direct, never leaves this phone';
  if (/(^|\.)ts\.net(:|$)/i.test(host)) return 'Tailscale — encrypted, direct to your laptop';
  if (/^\d+\.\d+\.\d+\.\d+(:|$)/.test(host)) return 'Local network — direct';
  return 'Direct link';
}

/** Where this copy of the app was loaded from. */
export function servedByLabel(): string {
  if (typeof location === 'undefined') return 'unknown';
  if (IS_LOCAL_MODE) return 'the laptop itself (local)';
  if (LOOPBACK.test(location.hostname)) return 'a local dev server';
  return 'GitHub Pages';
}
