import { useEffect, useState } from 'react';
import { iconObjectUrl } from '../services/iconBlob';

/** Resolve a versioned daemon icon URL into an authenticated blob URL. */
export function useIconObjectUrl(url: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setResolved(null);
    void iconObjectUrl(url).then((value) => {
      if (alive) setResolved(value);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  return resolved;
}
