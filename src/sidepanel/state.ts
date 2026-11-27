/**
 * The panel's states. There is no prepare button in the steady state: the panel prepares by
 * itself when nothing needs downloading. When PLaMo's model is missing, the download stands in
 * for 開始 (isFirstRun), so that 開始 does not start a 573MB download. 開始 still downloads the
 * language packs and Chrome's translator (their APIs need the click). `starting` (capturing the
 * tab and starting the recognizers) has 閉じる only, so that a second click cannot capture the
 * tab twice.
 */
import type { Availability } from '../types/web-ai';

export type State = 'idle' | 'preparing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';

export type Event =
  /** Preparing: by itself when everything is here, or from the first-run download action. */
  | 'prepare'
  | 'prepared'
  /** Back to idle: 開始 tries again. */
  | 'prepareFailed'
  | 'engineChanged'
  /** The selected engine is no longer usable (PLaMo failed to load again after a crash). */
  | 'lost'
  /** 開始: from ready it starts; from idle and error it prepares first. */
  | 'start'
  | 'started'
  | 'startFailed'
  | 'stop'
  /** The session ended: after 停止, or by itself when the captured tab ended. */
  | 'ended'
  /** From any state: the recognizer stopped for good, for example. */
  | 'fail';

export type Control = 'start' | 'stop' | 'engine' | 'clear' | 'export' | 'close';

const TRANSITIONS: Record<State, Partial<Record<Event, State>>> = {
  idle: { prepare: 'preparing', start: 'preparing', engineChanged: 'idle' },
  preparing: { prepared: 'ready', prepareFailed: 'idle' },
  ready: { start: 'starting', engineChanged: 'idle', lost: 'idle' },
  starting: { started: 'running', startFailed: 'ready', ended: 'ready' },
  running: { stop: 'stopping', ended: 'ready' },
  stopping: { ended: 'ready' },
  error: { start: 'preparing', engineChanged: 'idle' },
};

/** The state after `event`, or null when `state` does not accept it. */
export function next(state: State, event: Event): State | null {
  if (event === 'fail') return 'error';
  return TRANSITIONS[state][event] ?? null;
}

/** The controls each state enables. */
export const CONTROLS: Record<State, readonly Control[]> = {
  idle: ['start', 'engine', 'clear', 'export', 'close'],
  preparing: ['close'],
  ready: ['start', 'engine', 'clear', 'export', 'close'],
  starting: ['close'],
  running: ['stop', 'clear', 'close'],
  stopping: ['close'],
  error: ['start', 'engine', 'clear', 'export', 'close'],
};

/**
 * Whether the primary action is PLaMo's model download rather than 開始: idle, PLaMo selected,
 * and the model not in OPFS. Also after an eviction, not just the first run.
 */
export function isFirstRun(state: State, engine: 'plamo' | 'chrome', modelMissing: boolean): boolean {
  return state === 'idle' && engine === 'plamo' && modelMissing;
}

/**
 * Whether Chrome's translator can be offered as the other first-run choice. Both directions must
 * exist; a downloadable one is created within the click (its model downloads then).
 */
export function canOfferChrome(jaToEn: Availability, enToJa: Availability): boolean {
  return jaToEn !== 'unavailable' && enToJa !== 'unavailable';
}
