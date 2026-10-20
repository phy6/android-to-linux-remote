import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, Star } from 'lucide-react';
import { useIconObjectUrl } from '../hooks/useIconObjectUrl';
import {
  AppEntry,
  appIconUrl,
  cachedApps,
  favouriteApps,
  launchApp,
  listApps,
  toggleFavourite,
} from '../services/appsClient';

interface AppShortcutPanelProps {
  host: string;
  /** Where to draw it, computed by the mic so it hugs the cluster. */
  anchor: { left: number; top: number; width: number; height: number };
}

type LaunchState = 'idle' | 'busy' | 'done' | 'failed';

const AppIcon: React.FC<{ host: string; app: AppEntry; size: number }> = ({ host, app, size }) => {
  // The daemon now requires the device token, which <img> cannot send; the
  // hook fetches through the authenticated client and returns a blob URL.
  const url = useIconObjectUrl(appIconUrl(host, app));
  const style = { width: `${size}px`, height: `${size}px` };
  if (!url) {
    return (
      <div
        style={style}
        className="flex shrink-0 items-center justify-center rounded-lg bg-slate-700/70 text-sm font-semibold text-slate-200"
      >
        {app.name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      style={style}
      className="shrink-0 rounded-lg object-contain"
    />
  );
};

/**
 * Slide-in shortcut panel for the mic: the apps the user pinned, with the full
 * installed list behind a search. Launching happens on the laptop, so the panel
 * stays open and several apps can be started in a row.
 */
export const AppShortcutPanel: React.FC<AppShortcutPanelProps> = ({ host, anchor }) => {
  const [apps, setApps] = useState<AppEntry[]>(() => cachedApps(host));
  const [favIds, setFavIds] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<Record<string, LaunchState>>({});
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setApps(cachedApps(host));
    void listApps(host).then((found) => {
      if (alive && found.length) setApps(found);
    });
    return () => {
      alive = false;
    };
  }, [host]);

  useEffect(() => {
    if (apps.length) setFavIds(favouriteApps(apps).map((a) => a.id));
  }, [apps]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const byId = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const favourites = favIds.map((id) => byId.get(id)).filter((a): a is AppEntry => !!a);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle),
    );
  }, [apps, query]);

  const fire = async (app: AppEntry) => {
    if (state[app.id] === 'busy') return;
    setState((prev) => ({ ...prev, [app.id]: 'busy' }));
    const ok = await launchApp(host, app.id);
    setState((prev) => ({ ...prev, [app.id]: ok ? 'done' : 'failed' }));
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setState((prev) => ({ ...prev, [app.id]: 'idle' }));
    }, 1500);
  };

  const badge = (id: string) => {
    const at = state[id] ?? 'idle';
    if (at === 'busy') return <Loader2 className="w-4 h-4 shrink-0 animate-spin text-indigo-300" />;
    if (at === 'done') return <Check className="w-4 h-4 shrink-0 text-emerald-400" />;
    if (at === 'failed') return <span className="shrink-0 text-[10px] text-rose-400">failed</span>;
    return null;
  };

  const row = (app: AppEntry, pinned: boolean) => (
    <div key={app.id} className="flex items-center gap-1.5">
      <button
        type="button"
        data-app-item={app.id}
        onClick={() => void fire(app)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-800/90 px-2 py-1.5 text-left transition hover:border-indigo-400 active:scale-[0.99]"
      >
        <AppIcon host={host} app={app} size={28} />
        <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{app.name}</span>
        {badge(app.id)}
      </button>
      <button
        type="button"
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${app.name}`}
        data-app-pin={app.id}
        onClick={() => setFavIds(toggleFavourite(app.id))}
        className={`shrink-0 rounded-lg border p-1.5 ${
          pinned
            ? 'border-amber-400/60 bg-amber-500/10 text-amber-300'
            : 'border-slate-700/80 bg-slate-800/80 text-slate-500 hover:text-slate-300'
        }`}
      >
        <Star className="w-4 h-4" fill={pinned ? 'currentColor' : 'none'} />
      </button>
    </div>
  );

  return (
    <div
      data-app-panel="true"
      style={{
        left: `${anchor.left}px`,
        top: `${anchor.top}px`,
        width: `${anchor.width}px`,
        height: `${anchor.height}px`,
      }}
      className="fixed z-40 flex flex-col rounded-2xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
    >
      <div className="flex items-center justify-between gap-1 pb-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-slate-400">
          {showAll ? 'All apps' : 'Shortcuts'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-app-toggle="true"
            onClick={() => setShowAll((v) => !v)}
            className="rounded-lg border border-slate-700/80 bg-slate-800/80 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:border-indigo-400"
          >
            {showAll ? 'Pinned' : 'More'}
          </button>
        </div>
      </div>

      {showAll && (
        <div className="relative pb-2">
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            data-app-search="true"
            className="w-full rounded-lg border border-slate-700/80 bg-slate-800/80 py-1.5 pl-8 pr-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain touch-pan-y" style={{ gap: '4px' }}>
        {!apps.length && (
          <p className="px-1 py-6 text-center text-sm text-slate-400">
            No apps yet. Connect to the laptop to load its applications.
          </p>
        )}

        {!showAll && apps.length > 0 && favourites.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-slate-400">
            Nothing pinned. Open <span className="text-slate-200">More</span> and tap a star.
          </p>
        )}

        {(!showAll ? favourites : results).map((app) => row(app, favIds.includes(app.id)))}

        {showAll && !results.length && query && (
          <p className="px-1 py-6 text-center text-sm text-slate-400">No app matches “{query}”.</p>
        )}
      </div>
    </div>
  );
};

export default AppShortcutPanel;
