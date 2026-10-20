// Scripts and snippets for the dictation teleprompter.
//
// The laptop owns a folder of plain text files (@see SCRIPTS_DIR in the daemon)
// and exposes it over the same host:port the app already talks to. The phone
// reads that list to fill the teleprompter, and can also keep its own small set
// of snippets locally so a script is still there with the laptop offline.

import { apiBase, apiFetch } from './http';

export interface ScriptFile {
  name: string;
  size: number;
  modified: number;
}

export interface LocalSnippet {
  name: string;
  text: string;
  modified: number;
}

const LOCAL_KEY = 'taildeck_snippets';
const DEFAULT_SCRIPT_EXT = '.txt';

/** URL a guest can open to install the laptop's CA (guest/iOS WSS trust). */
export function caUrl(host: string): string | null {
  const base = apiBase(host);
  return base ? `${base}/taildeck-ca.crt` : null;
}

function isScriptName(name: string): boolean {
  return /\.(txt|md|markdown)$/i.test(name);
}

export async function listScripts(host: string): Promise<ScriptFile[]> {
  const base = apiBase(host);
  if (!base) return [];
  try {
    const res = await apiFetch(`${base}/api/scripts`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = Array.isArray(data?.scripts) ? data.scripts : [];
    return raw
      .filter((s: ScriptFile) => s && typeof s.name === 'string' && isScriptName(s.name))
      .map((s: ScriptFile) => ({
        name: s.name,
        size: Number(s.size) || 0,
        modified: Number(s.modified) || 0,
      }));
  } catch {
    return [];
  }
}

export async function getScript(host: string, name: string): Promise<string | null> {
  const base = apiBase(host);
  if (!base || !isScriptName(name)) return null;
  try {
    const res = await apiFetch(`${base}/api/scripts/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.text === 'string' ? data.text : null;
  } catch {
    return null;
  }
}

export async function saveScript(host: string, name: string, text: string): Promise<boolean> {
  const base = apiBase(host);
  if (!base || !isScriptName(name)) return false;
  try {
    const res = await apiFetch(`${base}/api/scripts/${encodeURIComponent(name)}`, {
      method: 'POST',
      // text/plain keeps this a CORS "simple request" - no preflight needed.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: text,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Local snippets (phone-side cache / offline) ---------------------------

export function listLocalSnippets(): LocalSnippet[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: LocalSnippet) => s && typeof s.name === 'string' && typeof s.text === 'string')
      .map((s: LocalSnippet) => ({
        name: s.name,
        text: s.text,
        modified: Number(s.modified) || 0,
      }));
  } catch {
    return [];
  }
}

function writeLocalSnippets(snippets: LocalSnippet[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snippets));
  } catch {
    // Storage full or blocked; the snippet simply is not kept.
  }
}

export function saveLocalSnippet(name: string, text: string): LocalSnippet[] {
  const clean = name.trim().replace(/[/\\]/g, '-').slice(0, 80) || 'snippet';
  const next = listLocalSnippets().filter((s) => s.name !== clean);
  next.push({ name: clean, text, modified: Date.now() });
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeLocalSnippets(next);
  return next;
}

export function deleteLocalSnippet(name: string): LocalSnippet[] {
  const next = listLocalSnippets().filter((s) => s.name !== name);
  writeLocalSnippets(next);
  return next;
}

/** A sensible file name for a brand-new script the user saves to the laptop. */
export function suggestScriptName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `script-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${DEFAULT_SCRIPT_EXT}`;
}
