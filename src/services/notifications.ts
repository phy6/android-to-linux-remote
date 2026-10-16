const iconPath = () => `${import.meta.env.BASE_URL}pwa-192x192.png`.replace(/\/{2,}/g, '/');

export type AlertPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationSupport(): AlertPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<AlertPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

interface ConnectionNotice {
  connected: boolean;
  host: string;
  /** Plain-English route, e.g. "Local network — direct". No ISP or carrier wording. */
  route?: string;
}

/**
 * Posts a real Android system notification via the service worker. Returns
 * false when notifications are unavailable so the caller can fall back to an
 * in-app banner.
 */
export async function showConnectionNotice({ connected, host, route }: ConnectionNotice): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const title = connected ? 'TailDeck connected' : 'TailDeck disconnected';
  const where = route ? `${host} · ${route}` : host;
  const options: NotificationOptions & { renotify?: boolean } = {
    body: connected ? `Linked to ${where}` : `Lost the link to ${where}`,
    icon: iconPath(),
    badge: iconPath(),
    tag: 'taildeck-connection',
    renotify: false,
    // Reuse one notification slot instead of stacking them while flapping.
    silent: false,
    data: { url: window.location.href },
  };

  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    // Fall through to the constructor below.
  }

  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

interface MessageNotice {
  title?: string;
  body: string;
}

/**
 * Posts a laptop-initiated notice (e.g. `taildeck-daemon.py notify "..."`) as a
 * real system notification. Best-effort: it only lands while this page is alive.
 */
export async function showMessageNotice({ title = 'TailDeck', body }: MessageNotice): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    icon: iconPath(),
    badge: iconPath(),
    tag: 'taildeck-message',
    renotify: true,
    data: { url: window.location.href },
  };

  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    // Fall through to the constructor below.
  }

  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/** Tapping the notification should bring the deck back to the front. */
export function focusOnNotificationClick(): void {  if (typeof navigator === 'undefined') return;
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if ((event.data as { type?: string })?.type !== 'taildeck-focus') return;
    window.focus();
  });
}
