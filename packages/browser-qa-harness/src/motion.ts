import type { BrowserContext, Page } from 'playwright-core';

/** Longest allowed duration in milliseconds. `sheet` applies to anything inside a sheet or drawer. */
export interface DurationLimits {
  default: number;
  sheet: number;
}

export const DEFAULT_LIMITS: Readonly<DurationLimits> = { default: 300, sheet: 450 };

/** CSS property names that cause layout when animated. Matches the name itself and its longhands (`margin-left`). */
export const LAYOUT_PROPERTIES: readonly string[] = [
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'top', 'right', 'bottom', 'left', 'inset',
  'margin', 'padding', 'border-width', 'font-size', 'line-height', 'flex-basis', 'gap', 'grid-template-columns',
];

/** One declaration read from a stylesheet. */
export interface CssDeclaration {
  selector: string;
  /** `transition`, `transition-property`, `transition-duration`, `animation` or `animation-duration`. */
  name: string;
  /** The value as written. */
  raw: string;
  /** The value with `var()` resolved. */
  value: string;
  /** The rule sets `animation-iteration-count: infinite`. */
  loops?: boolean;
}

export interface CssClassification {
  violations: string[];
  /** Longest finite duration outside a sheet, in milliseconds. */
  longestMs: number;
  /** Longest finite duration inside a sheet, in milliseconds. */
  longestSheetMs: number;
}

export interface CssAuditOptions {
  limits?: Partial<DurationLimits>;
  /** Selectors matching this belong to a sheet and get the sheet limit. Default: none. */
  sheetPattern?: RegExp | null;
  /** Property names counted as layout. Default `LAYOUT_PROPERTIES`. */
  layoutProperties?: readonly string[];
}

/** Splits on commas that are not inside parentheses. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** `300ms` -> 300, `.5s` -> 500. */
export function cssTimeToMs(token: string): number {
  return token.endsWith('ms') ? parseFloat(token) : parseFloat(token) * 1000;
}

/** Durations and delays found in one transition or animation segment, in order. Function arguments such as `cubic-bezier(...)` are skipped. */
export function timesIn(segment: string): number[] {
  return (segment.replace(/\([^()]*\)/g, '').match(/(?<![\w.-])\d*\.?\d+m?s\b/g) ?? []).map(cssTimeToMs);
}

/** True when a CSS or script property name is a layout property or a longhand of one. Accepts camelCase. */
export function isLayoutProperty(name: string, list: readonly string[] = LAYOUT_PROPERTIES): boolean {
  const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return list.some((p) => kebab === p || kebab.startsWith(`${p}-`));
}

/**
 * Applies the motion rules to stylesheet declarations: no `transition: all`, no animated layout
 * property, nothing longer than the limit. Endless animations are skipped here; `judgeMotion` covers them.
 */
export function classifyCssDeclarations(rules: readonly CssDeclaration[], options: CssAuditOptions = {}): CssClassification {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const layout = options.layoutProperties ?? LAYOUT_PROPERTIES;
  const violations: string[] = [];
  let longestMs = 0;
  let longestSheetMs = 0;

  for (const rule of rules) {
    const segments = splitTopLevel(rule.value);
    if (rule.name === 'transition' || rule.name === 'transition-property') {
      for (const segment of segments) {
        const property = segment.split(/\s+/)[0] ?? '';
        if (property === 'all') violations.push(`${rule.selector} { ${rule.name}: ${rule.raw} } uses "all"`);
        if (isLayoutProperty(property, layout)) violations.push(`${rule.selector} animates layout property ${property}`);
      }
    }
    if (rule.name === 'transition-property') continue;
    if (rule.loops || /\binfinite\b/.test(rule.value)) continue;
    const isSheet = options.sheetPattern ? options.sheetPattern.test(rule.selector) : false;
    for (const segment of segments) {
      const times = timesIn(segment);
      const duration = rule.name.endsWith('duration') ? Math.max(0, ...times) : (times[0] ?? 0);
      if (isSheet) longestSheetMs = Math.max(longestSheetMs, duration);
      else longestMs = Math.max(longestMs, duration);
      const limit = isSheet ? limits.sheet : limits.default;
      if (duration > limit) violations.push(`${rule.selector} { ${rule.name}: ${rule.raw} } runs ${duration} ms (limit ${limit})`);
    }
  }
  return { violations, longestMs, longestSheetMs };
}

/** Reads every transition and animation declaration from the page's stylesheets, with `var()` resolved. */
export async function readCssDeclarations(page: Page): Promise<CssDeclaration[]> {
  return page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const resolve = (text: string) => {
      let out = text;
      for (let i = 0; i < 6 && out.includes('var('); i++) {
        out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g, (_, name: string) => rootStyle.getPropertyValue(name).trim() || '0s');
      }
      return out;
    };
    const found: { selector: string; name: string; raw: string; value: string; loops: boolean }[] = [];
    const walk = (list: CSSRuleList, prefix: string) => {
      for (const rule of Array.from(list)) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ? styleRule.selectorText.replaceAll('&', prefix) : prefix;
        if (styleRule.style) {
          const loops = styleRule.style.getPropertyValue('animation-iteration-count') === 'infinite';
          for (const name of ['transition', 'transition-property', 'transition-duration', 'animation', 'animation-duration']) {
            const value = styleRule.style.getPropertyValue(name);
            if (value) found.push({ selector: selector || rule.cssText.slice(0, 40), name, raw: value, value: resolve(value), loops });
          }
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested?.length) walk(nested, selector);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules, '');
      } catch {
        // A cross-origin stylesheet cannot be read.
      }
    }
    return found;
  });
}

export interface CssAuditResult extends CssClassification {
  /** How many declarations were read. A zero here means the check saw nothing. */
  declarationsRead: number;
}

/** Reads the loaded page's stylesheets and applies the CSS motion rules. */
export async function auditCss(page: Page, options: CssAuditOptions = {}): Promise<CssAuditResult> {
  const declarations = await readCssDeclarations(page);
  return { ...classifyCssDeclarations(declarations, options), declarationsRead: declarations.length };
}

/** One animation or transition that actually ran. */
export interface MotionRecord {
  kind: string;
  name: string;
  properties: string[];
  duration: number;
  iterations: number | 'infinite';
  target: string;
  inSheet: boolean;
}

/** Runs in the page: records every animation and transition into `window.__motion`. */
export function motionRecorder(sheetSelector: string | null): void {
  const w = window as unknown as { __seen: WeakSet<object>; __motion: unknown[] };
  w.__seen = new WeakSet();
  w.__motion = [];
  const describe = (el: Element | null) => {
    if (!el) return 'unknown';
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const tick = () => {
    for (const animation of document.getAnimations()) {
      if (w.__seen.has(animation)) continue;
      w.__seen.add(animation);
      const effect = animation.effect as KeyframeEffect | null;
      const timing = effect?.getComputedTiming?.() ?? ({} as ComputedEffectTiming);
      const target = effect?.target ?? null;
      let properties: string[] = [];
      try {
        properties = [...new Set((effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k)))].filter(
          (k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k),
        );
      } catch {
        properties = [];
      }
      w.__motion.push({
        kind: animation.constructor.name,
        name: (animation as CSSTransition).transitionProperty ?? (animation as CSSAnimation).animationName ?? 'script',
        properties,
        duration: Number(timing.duration) || 0,
        iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
        target: describe(target),
        inSheet: Boolean(sheetSelector && target?.closest?.(sheetSelector)),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export interface MotionRecorderOptions {
  /** Elements inside this selector count as sheet motion and get the longer limit. */
  sheetSelector?: string | null;
}

/**
 * Starts recording animations in every page of a context, or in one page. Call it before navigating,
 * since it works through an init script.
 */
export async function installMotionRecorder(target: Page | BrowserContext, options: MotionRecorderOptions = {}): Promise<void> {
  await target.addInitScript(motionRecorder, options.sheetSelector ?? null);
}

/** Returns what has been recorded since the last drain and clears it. */
export function drainMotion(page: Page): Promise<MotionRecord[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __motion?: unknown[] };
    const out = w.__motion ?? [];
    w.__motion = [];
    return out as MotionRecord[];
  });
}

export interface JudgeOptions {
  /** Animation names that may run forever, and that are not judged by length (a spinner, a scroll cue). */
  endlessOk?: readonly string[];
  limits?: Partial<DurationLimits>;
  layoutProperties?: readonly string[];
}

/** Checks recorded animations against the rules and returns one message per violation, each starting with `label`. */
export function judgeMotion(records: readonly MotionRecord[], label: string, options: JudgeOptions = {}): string[] {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const endlessOk = options.endlessOk ?? [];
  const violations: string[] = [];
  for (const record of records) {
    const properties = record.properties.length ? record.properties : [record.name];
    const allowed = endlessOk.includes(record.name);
    if (record.iterations === 'infinite' || allowed) {
      if (!allowed) violations.push(`${label}: endless animation ${record.name} on ${record.target}`);
      continue;
    }
    const limit = record.inSheet ? limits.sheet : limits.default;
    if (record.duration > limit) violations.push(`${label}: ${record.name} on ${record.target} runs ${record.duration} ms (limit ${limit})`);
    for (const property of properties) {
      if (isLayoutProperty(property, options.layoutProperties)) violations.push(`${label}: layout property ${property} animates on ${record.target}`);
    }
  }
  return violations;
}

export interface MotionStep {
  label: string;
  /** Performs the interaction; the animations it starts are recorded. */
  run(page: Page): Promise<void>;
}

export interface MotionReport {
  /** Per step label, a line for each animation that ran: `name 120ms on tag.class`. */
  steps: Record<string, string[]>;
  violations: string[];
}

/**
 * Runs interaction steps on a page that has a recorder installed, and judges the animations each one
 * started. `prefix` is put before each step label in the violation messages.
 */
export async function runMotionSteps(page: Page, steps: readonly MotionStep[], options: JudgeOptions & { prefix?: string } = {}): Promise<MotionReport> {
  const report: MotionReport = { steps: {}, violations: [] };
  await drainMotion(page);
  for (const step of steps) {
    await step.run(page);
    const records = await drainMotion(page);
    report.steps[step.label] = records.map((r) => `${r.name} ${r.duration}ms on ${r.target}`);
    report.violations.push(...judgeMotion(records, `${options.prefix ?? ''}${step.label}`, options));
  }
  return report;
}
