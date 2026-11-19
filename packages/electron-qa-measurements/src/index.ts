export type { Bounds, CommonOptions, InputEventLike, KeyInjector, Stats, WebContentsLike, WindowLike } from './types.js';
export { computeStats, generateText, type SampleKind } from './stats.js';
export { createInputEventInjector, createProtocolInjector, emulatePageFocus, modifierForPlatform, type ProtocolSend } from './input.js';
export { armPaletteScript, createLatencyProbeScript, focusFieldScript, paintScript, readFieldScript, readProbeScript, type ProbeOptions } from './probe.js';
export {
  checkRecovery,
  describeWindow,
  measureCommandPalette,
  measureLaunchMarks,
  measureTyping,
  readArg,
  readField,
  reloadPage,
  typeAndRecord,
  writeJsonReport,
  type DisplayInfo,
  type KillRecord,
  type KillRecordOptions,
  type LaunchMarks,
  type LaunchMarksOptions,
  type PaletteOptions,
  type PaletteResult,
  type RecoveryResult,
  type TypingOptions,
  type TypingResult,
  type WindowDescription,
} from './scenarios.js';
