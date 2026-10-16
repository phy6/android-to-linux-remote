// Passkey (WebAuthn) registration and assertion for laptop unlock.
//
// The phone's fingerprint gates a hardware-backed key on the phone itself; only
// the public half ever reaches the laptop. This module talks to the daemon's
// /api/webauthn/* and /api/auth/* endpoints and builds the WebAuthn options the
// platform authenticator needs.
//
// Two constraints shape everything here:
//   * A relying-party id must be a real domain, never an IP literal. So the app
//     has to be served from a domain (GitHub Pages, or the tailnet name) - a
//     page opened straight from https://<laptop-ip>:8443/ cannot register.
//   * The rpId must match the page's own origin domain, so the client names it
//     rather than relying on the daemon's default.

import { apiBase } from './scriptsClient';

export interface AuthCredentialInfo {
  id: string;
  label?: string;
  user?: string;
  created?: number;
}

export interface AuthInfo {
  configured: boolean;
  rpId: string;
  origin: string;
  user: string;
  credentials: AuthCredentialInfo[];
}

export interface AuthChallenge {
  requestId: string;
  challenge: string;
  rpId: string;
  origin: string;
  allowCredentials: string[];
  timeoutMs: number;
}

export interface AuthAssertion {
  requestId: string;
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export function bufToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uToBuf(text: string): ArrayBuffer {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob((text + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Minimal CBOR reader: enough to walk an attestationObject and lift the COSE
// public key out of its authData. Returns the value and the index just past it.
function cborFirst(data: Uint8Array, offset: number): { value: unknown; end: number } {
  const ib = data[offset];
  const major = ib >> 5;
  const ai = ib & 0x1f;
  let idx = offset + 1;
  let val = 0;
  if (ai < 24) {
    val = ai;
  } else if (ai === 24) {
    val = data[idx];
    idx += 1;
  } else if (ai === 25) {
    val = (data[idx] << 8) | data[idx + 1];
    idx += 2;
  } else if (ai === 26) {
    val = (data[idx] << 24) | (data[idx + 1] << 16) | (data[idx + 2] << 8) | data[idx + 3];
    idx += 4;
  } else if (ai === 27) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = v * 256 + data[idx + i];
    idx += 8;
    val = v;
  } else {
    throw new Error('unsupported CBOR length');
  }

  if (major === 0) return { value: val, end: idx };
  if (major === 1) return { value: -1 - val, end: idx };
  if (major === 2) return { value: data.slice(idx, idx + val), end: idx + val };
  if (major === 3) return { value: new TextDecoder().decode(data.slice(idx, idx + val)), end: idx + val };
  if (major === 4) {
    const arr: unknown[] = [];
    let o = idx;
    for (let i = 0; i < val; i++) {
      const r = cborFirst(data, o);
      arr.push(r.value);
      o = r.end;
    }
    return { value: arr, end: o };
  }
  if (major === 5) {
    const map: Record<string, unknown> = {};
    let o = idx;
    for (let i = 0; i < val; i++) {
      const k = cborFirst(data, o);
      const v = cborFirst(data, k.end);
      map[String(k.value)] = v.value;
      o = v.end;
    }
    return { value: map, end: o };
  }
  if (major === 6) return cborFirst(data, idx);
  throw new Error('unsupported CBOR major type');
}

/** Pull the COSE public-key bytes out of an authenticator's attestationObject. */
function cosePublicKey(attestationObject: ArrayBuffer): string | null {
  try {
    const { value } = cborFirst(new Uint8Array(attestationObject), 0);
    const authData = (value as { authData?: Uint8Array })?.authData;
    if (!(authData instanceof Uint8Array)) return null;
    const flags = authData[32];
    if (!(flags & 0x40)) return null; // no attested credential data
    const credIdLen = (authData[53] << 8) | authData[54];
    const coseOffset = 55 + credIdLen;
    const { end } = cborFirst(authData, coseOffset);
    return bufToB64u(authData.slice(coseOffset, end).buffer);
  } catch {
    return null;
  }
}

/** True when this page can create a passkey at all. */
export function webAuthnAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
  const host = location.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  return !isIp;
}

export async function fetchAuthInfo(host: string): Promise<AuthInfo | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/auth/info`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as AuthInfo;
  } catch {
    return null;
  }
}

export interface RegisterResult {
  ok: boolean;
  error?: string;
}

/** Create a passkey for this phone and store its public half on the laptop. */
export async function registerPasskey(
  host: string,
  user: string,
  label: string,
): Promise<RegisterResult> {
  const base = apiBase(host);
  if (!base) return { ok: false, error: 'not connected' };
  if (!webAuthnAvailable()) {
    return { ok: false, error: 'This page must be opened from a domain over https.' };
  }
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'TailDeck', id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: user || 'phone',
          displayName: user || 'TailDeck phone',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: {
          userVerification: 'required',
          authenticatorAttachment: 'platform',
        },
        timeout: 60000,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, error: 'cancelled' };

    const response = credential.response as AuthenticatorAttestationResponse;
    const publicKey = cosePublicKey(response.attestationObject);
    if (!publicKey) return { ok: false, error: 'could not read the new key' };

    const res = await fetch(`${base}/api/webauthn/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentialId: bufToB64u(credential.rawId),
        publicKey,
        label,
        user,
        rpId: location.hostname,
        origin: location.origin,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data?.ok ? { ok: true } : { ok: false, error: data?.error || 'register failed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'registration failed' };
  }
}

export async function deleteCredential(host: string, id: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/webauthn/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Prompt for the fingerprint and return the signed assertion, or null. */
export async function respondToChallenge(challenge: AuthChallenge): Promise<AuthAssertion | null> {
  if (!webAuthnAvailable()) return null;
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: b64uToBuf(challenge.challenge),
        rpId: challenge.rpId,
        allowCredentials: (challenge.allowCredentials || []).map((id) => ({
          id: b64uToBuf(id),
          type: 'public-key' as const,
        })),
        userVerification: 'required',
        timeout: challenge.timeoutMs || 60000,
      },
    })) as PublicKeyCredential | null;
    if (!credential) return null;
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      requestId: challenge.requestId,
      credentialId: bufToB64u(credential.rawId),
      authenticatorData: bufToB64u(response.authenticatorData),
      clientDataJSON: bufToB64u(response.clientDataJSON),
      signature: bufToB64u(response.signature),
    };
  } catch {
    return null;
  }
}

/** Ask the laptop for a challenge this phone can sign. */
export async function beginAuth(
  host: string,
  opts: { user?: string; rpId?: string; origin?: string } = {},
): Promise<AuthChallenge | null> {
  const base = apiBase(host);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/auth/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: opts.user,
        rpId: opts.rpId ?? location.hostname,
        origin: opts.origin ?? location.origin,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    return {
      requestId: String(data.requestId),
      challenge: String(data.challenge),
      rpId: String(data.rpId),
      origin: String(data.origin),
      allowCredentials: Array.isArray(data.allowCredentials) ? data.allowCredentials.map(String) : [],
      timeoutMs: Number(data.timeoutMs) || 60000,
    };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  ok: boolean;
  requestId?: string;
  status?: string;
  error?: string;
}

/**
 * App-initiated unlock: begin a challenge, prompt for the fingerprint and hand
 * the assertion back. Returns a verified request id that privileged daemon
 * actions can be gated on (a single-use token).
 */
export async function verifyWithPhone(host: string, opts: { user?: string } = {}): Promise<VerifyResult> {
  const base = apiBase(host);
  if (!base) return { ok: false, error: 'not connected' };
  const challenge = await beginAuth(host, opts);
  if (!challenge) return { ok: false, error: 'could not start the unlock request' };
  const assertion = await respondToChallenge(challenge);
  if (!assertion) return { ok: false, error: 'cancelled' };
  try {
    const res = await fetch(`${base}/api/auth/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assertion),
    });
    const data = await res.json();
    return { ok: !!data?.ok, requestId: challenge.requestId, status: data?.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verification failed' };
  }
}
