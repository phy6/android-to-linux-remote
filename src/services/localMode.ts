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
