// When the laptop daemon serves the app over http on the hotspot, the page
// origin *is* the laptop. In that case the browser can talk to it over ws://
// on the same host, which keeps audio and input on the local link instead of
// hairpin through the carrier, and works with mobile data switched off.
//
// An https page is not allowed to open a ws:// socket (mixed content), so this
// mode only exists for the http-served copy. The Pages copy is unaffected.

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
const HOSTED = /(^|\.)github\.io$/i;

export function localHost(): string {
  if (typeof location === 'undefined') return '';
  const { protocol, hostname, host } = location;
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  if (HOSTED.test(hostname) || LOOPBACK.test(hostname)) return '';
  return host;
}

export const LOCAL_HOST: string = localHost();

/** True when the app itself was loaded from the laptop daemon. */
export const IS_LOCAL_MODE: boolean = LOCAL_HOST !== '';

/** Human-readable description of how the phone is currently reaching the laptop. */
export function describeRoute(host: string, localMode: boolean, connected: boolean): string {
  if (!host) return 'no address set';
  if (!connected) return 'not connected';
  if (localMode) return 'Same hotspot — never leaves the phone';
  if (/(^|\.)ts\.net(:|$)/i.test(host)) return 'Tailscale — via the carrier/internet';
  if (/^\d+\.\d+\.\d+\.\d+(:|$)/.test(host)) return 'LAN address — direct';
  return 'custom host';
}

/** Where this copy of the app was loaded from. */
export function servedByLabel(): string {
  if (typeof location === 'undefined') return 'unknown';
  if (IS_LOCAL_MODE) return 'the laptop itself (local)';
  if (LOOPBACK.test(location.hostname)) return 'a local dev server';
  return 'GitHub Pages';
}
