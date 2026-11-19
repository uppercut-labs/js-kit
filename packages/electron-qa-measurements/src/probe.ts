/**
 * Page-side scripts. Each is an expression for `webContents.executeJavaScript`.
 * Results are kept on `window.__qaLatency`, `window.__qaSlow` and `window.__qaPalette`.
 */

export interface ProbeOptions {
  /** `PerformanceObserver` duration threshold for slow interactions, in ms. The platform minimum is 16. */
  slowThresholdMs?: number;
}

const q = (value: string) => JSON.stringify(value);

/**
 * Installs listeners on the field matched by `field` (a CSS selector). For each key it records the time from
 * the key event's own timestamp to the end of the frame that rendered the resulting change.
 * Safe to call again for the same element.
 */
export function createLatencyProbeScript(field: string, options: ProbeOptions = {}): string {
  const threshold = Math.max(16, options.slowThresholdMs ?? 16);
  return `(() => {
  const el = document.querySelector(${q(field)});
  if (!el) return false;
  if (window.__qaProbeFor === el) return true;
  window.__qaProbeFor = el;
  window.__qaLatency = [];
  window.__qaSlow = [];
  let keyAt = null;
  el.addEventListener('keydown', (e) => { keyAt = e.timeStamp; }, true);
  el.addEventListener('input', () => {
    const t0 = keyAt;
    if (t0 === null) return;
    keyAt = null;
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => window.__qaLatency.push(performance.now() - t0);
      channel.port2.postMessage(0);
    });
  }, true);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name === 'keydown' || entry.name === 'keypress' || entry.name === 'input') window.__qaSlow.push(entry.duration);
  }).observe({ type: 'event', durationThreshold: ${threshold}, buffered: false });
  return true;
})()`;
}

export const resetProbeScript = 'window.__qaLatency = []; window.__qaSlow = []; true';

export function readProbeScript(field: string): string {
  return `(() => { const el = document.querySelector(${q(field)}); return { lat: window.__qaLatency || [], slow: window.__qaSlow || [], length: el ? String(el.value ?? el.textContent ?? '').length : 0 }; })()`;
}

export function focusFieldScript(field: string): string {
  return `(() => {
  const el = document.querySelector(${q(field)});
  if (!el) return false;
  el.focus();
  if (typeof el.value === 'string' && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
  return document.activeElement === el;
})()`;
}

export function readFieldScript(field: string): string {
  return `(() => { const el = document.querySelector(${q(field)}); return el ? String(el.value ?? el.textContent ?? '') : null; })()`;
}

/**
 * Arms a one-shot listener for the key chord. When the chord arrives, polls each frame until `openSelector`
 * matches an element, then stores the time from the key event to the end of that frame in `window.__qaPalette`.
 */
export function armPaletteScript(openSelector: string, key: string, modifier: 'control' | 'meta'): string {
  const flag = modifier === 'meta' ? 'metaKey' : 'ctrlKey';
  return `(() => {
  window.__qaPalette = null;
  window.addEventListener('keydown', function once(e) {
    if (e.key.toLowerCase() !== ${q(key.toLowerCase())} || !e.${flag}) return;
    window.removeEventListener('keydown', once, true);
    const t0 = e.timeStamp;
    const look = () => {
      if (document.querySelector(${q(openSelector)})) {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { window.__qaPalette = performance.now() - t0; };
        channel.port2.postMessage(0);
      } else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, true);
  return true;
})()`;
}

export const readPaletteScript = 'window.__qaPalette';

/** Resolves with the first-contentful-paint time and the clock after two animation frames. */
export const paintScript = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
  fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || null,
  timeOrigin: performance.timeOrigin,
  now: performance.now(),
}))))`;
