export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other';

/** True when the page runs as an installed app: the standalone display mode or iOS `navigator.standalone`. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mql?.matches) || ios;
}

/** Coarse platform from a user agent string. Pass `ua` to test; defaults to `navigator.userAgent`. */
export function detectPlatform(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): Platform {
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  // iPadOS reports itself as a Mac.
  if (/Macintosh/.test(ua)) {
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && ua === navigator.userAgent
      ? 'ios'
      : 'mac';
  }
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'other';
}
