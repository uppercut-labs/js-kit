const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isHidden(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style?.display === 'none' || style?.visibility === 'hidden';
}

/**
 * Elements inside `root` that Tab can reach, in DOM order.
 * Disabled, hidden and `tabindex="-1"` elements are left out, and only the
 * checked (or first) radio of each named group is returned.
 */
export function getTabbableElements(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.getAttribute('tabindex') === '-1') return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    return !isHidden(el);
  });

  const checked = new Map<string, HTMLInputElement>();
  for (const el of candidates) {
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name && el.checked) {
      checked.set(el.name, el);
    }
  }
  const seen = new Set<string>();
  return candidates.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
    const picked = checked.get(el.name);
    if (picked) return el === picked;
    if (seen.has(el.name)) return false;
    seen.add(el.name);
    return true;
  });
}

/**
 * Where focus should go after a Tab or Shift+Tab press inside `container`,
 * or null when normal browser movement already stays inside it.
 */
export function nextTrappedFocus(
  container: HTMLElement,
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  const items = getTabbableElements(container);
  if (items.length === 0) return container;
  const first = items[0];
  const last = items[items.length - 1];
  if (!active || !container.contains(active) || active === container) return backwards ? last : first;
  if (backwards && active === first) return last;
  if (!backwards && active === last) return first;
  return null;
}
