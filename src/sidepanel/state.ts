/**
 * The panel's states. There is no prepare button: the panel prepares by itself when nothing needs
 * downloading, and otherwise 開始 prepares first (its click is the user gesture that downloads
 * need). `starting` (capturing the tab and starting the recognizers) has 閉じる only, so that a
 * second click cannot capture the tab twice.
 */
export type State = 'idle' | 'preparing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';

export type Event =
  /** Preparing without a click: everything needed is already on this machine. */
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

export type Control = 'start' | 'stop' | 'engine' | 'clear' | 'close';

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
  idle: ['start', 'engine', 'clear', 'close'],
  preparing: ['close'],
  ready: ['start', 'engine', 'clear', 'close'],
  starting: ['close'],
  running: ['stop', 'clear', 'close'],
  stopping: ['close'],
  error: ['start', 'engine', 'clear', 'close'],
};
