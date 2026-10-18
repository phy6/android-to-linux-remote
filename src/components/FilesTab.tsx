import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Folder,
  File as FileIcon,
  Download,
  Upload,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Link2,
  Send,
} from 'lucide-react';
import {
  ShareEntry,
  listFiles,
  downloadFile,
  uploadFile,
  saveBlob,
  transferFileViaPhone,
} from '../services/filesClient';
import { ShareLinkDialog } from './ShareLinkDialog';
import { ShareLinksPanel } from './ShareLinksPanel';

interface FilesTabProps {
  host: string;
  /** Other saved laptops this phone can push files to, brokered via the phone. */
  otherHosts?: Array<{ host: string; name: string }>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatWhen(seconds: number): string {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const FilesTab: React.FC<FilesTabProps> = ({ host, otherHosts = [] }) => {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<ShareEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharesKey, setSharesKey] = useState(0);
  // Which file's "send to another laptop" target tray is open.
  const [sendFor, setSendFor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the picker was opened; the upload must not follow a later navigation.
  const uploadDirRef = useRef('');

  const load = useCallback(
    async (target: string) => {
      setStatus('loading');
      const listing = await listFiles(host, target);
      if (!listing) {
        setEntries([]);
        setStatus('error');
        return;
      }
      setEntries(listing.entries);
      setStatus('ready');
    },
    [host],
  );

  useEffect(() => {
    load(dir);
  }, [dir, load]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 3000);
    return () => window.clearTimeout(t);
  }, [note]);

  const openPicker = () => {
    uploadDirRef.current = dir;
    inputRef.current?.click();
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const target = uploadDirRef.current;
    setBusy('__upload__');
    let ok = 0;
    for (const f of files) {
      if (await uploadFile(host, target, f)) ok += 1;
    }
    setBusy(null);
    setNote(
      ok === files.length
        ? `Uploaded ${ok} file${ok === 1 ? '' : 's'}`
        : `Uploaded ${ok} of ${files.length}`,
    );
    if (target === dir) load(dir);
  };

  const onDownload = async (entry: ShareEntry) => {
    setBusy(entry.path);
    const blob = await downloadFile(host, entry.path);
    setBusy(null);
    if (!blob) {
      setNote(`Could not download ${entry.name}`);
      return;
    }
    saveBlob(blob, entry.name);
    setNote(`Saved ${entry.name}`);
  };

  const onSendTo = async (entry: ShareEntry, target: { host: string; name: string }) => {
    setSendFor(null);
    setBusy(entry.path);
    const result = await transferFileViaPhone(host, target.host, entry.path, '');
    setBusy(null);
    setNote(
      result.ok
        ? `Sent ${entry.name} to ${target.name}`
        : `Could not send ${entry.name}: ${result.error ?? 'unknown error'}`,
    );
  };

  const parts = dir ? dir.split('/') : [];
  const crumbs = [
    { label: 'Share', path: '' },
    ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') })),
  ];
  const uploading = busy === '__upload__';

  return (
    <div className="space-y-4 text-xs">
      {/* Breadcrumb + directory actions */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 flex items-center gap-0.5 overflow-x-auto">
          {crumbs.map((crumb, i) => (
            <React.Fragment key={crumb.path || 'root'}>
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
              <button
                onClick={() => setDir(crumb.path)}
                className={`px-1.5 py-1 rounded-lg whitespace-nowrap ${
                  i === crumbs.length - 1
                    ? 'text-slate-100 font-medium'
                    : 'text-sky-400 hover:text-sky-300'
                }`}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>
        <button
          onClick={() => load(dir)}
          disabled={status === 'loading'}
          title="Refresh"
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={openPicker}
          disabled={uploading}
          className="p-2 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25 disabled:opacity-50 shrink-0"
          title="Upload here"
        >
          <Upload className="w-4 h-4" />
        </button>
        <button
          onClick={() => setSharing(true)}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white shrink-0"
          title="Share this folder as a link"
        >
          <Link2 className="w-4 h-4" />
        </button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
      </div>

      {note && (
        <div className="p-2.5 rounded-xl bg-sky-950/40 border border-sky-500/30 text-sky-200">
          {note}
        </div>
      )}

      {status === 'error' ? (
        <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 flex items-center gap-3 text-slate-400">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <div>
            <div className="text-slate-200 font-medium">Share folder is not available</div>
            <div className="text-[11px]">It lives on the laptop at ~/taildeck-share.</div>
          </div>
        </div>
      ) : status === 'loading' && entries.length === 0 ? (
        <div className="p-4 text-center text-slate-500">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="p-4 rounded-2xl bg-slate-900 border border-dashed border-slate-800 text-center text-slate-400">
          {dir ? 'This folder is empty.' : 'Share folder is empty — upload a file to get started.'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div key={entry.path} className="space-y-1.5">
              <div
                role="button"
                tabIndex={0}
                aria-disabled={busy === entry.path}
                onClick={() => (entry.dir ? setDir(entry.path) : onDownload(entry))}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  if (entry.dir) setDir(entry.path);
                  else void onDownload(entry);
                }}
                className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-left hover:border-slate-700 active:bg-slate-800/60 ${
                  busy === entry.path ? 'opacity-60' : 'cursor-pointer'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                    entry.dir
                      ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {entry.dir ? <Folder className="w-4 h-4" /> : <FileIcon className="w-4 h-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-slate-100 truncate">{entry.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {entry.dir ? 'Folder' : formatSize(entry.size)}
                    {entry.modified ? ` · ${formatWhen(entry.modified)}` : ''}
                  </div>
                </div>
                {!entry.dir && otherHosts.length > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSendFor(sendFor === entry.path ? null : entry.path);
                    }}
                    title="Send to another laptop"
                    className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-sky-300 shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
                {entry.dir ? (
                  <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />
                ) : (
                  <Download
                    className={`w-4 h-4 shrink-0 ${
                      busy === entry.path ? 'text-sky-400 animate-pulse' : 'text-slate-500'
                    }`}
                  />
                )}
              </div>
              {sendFor === entry.path && (
                <div className="flex flex-wrap items-center gap-1.5 pl-10">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Send to</span>
                  {otherHosts.map((target) => (
                    <button
                      key={target.host}
                      type="button"
                      onClick={() => void onSendTo(entry, target)}
                      className="px-2 py-1 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[10px] font-semibold hover:bg-sky-500/25"
                    >
                      {target.name || target.host}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ShareLinksPanel host={host} refreshKey={sharesKey} />

      {sharing && (
        <ShareLinkDialog
          host={host}
          dir={dir}
          onClose={() => setSharing(false)}
          onCreated={() => setSharesKey((k) => k + 1)}
        />
      )}
    </div>
  );
};
