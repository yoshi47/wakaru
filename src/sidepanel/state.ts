/**
 * The panel's states. `starting` (capturing the tab and starting the recognizers) has 閉じる only,
 * so that a second click cannot capture the tab twice.
 */
export type State = 'idle' | 'preparing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';

export type Event =
  | 'prepare'
  | 'prepared'
  /** Back to idle with "もう一度押してください". */
  | 'prepareFailed'
  | 'engineChanged'
  /** The selected engine is no longer usable (PLaMo failed to load again after a crash). */
  | 'lost'
  | 'start'
  | 'started'
  | 'startFailed'
  | 'stop'
  /** The session ended: after 停止, or by itself when the captured tab ended. */
  | 'ended'
  /** From any state: the recognizer stopped for good, for example. */
  | 'fail'
  | 'reset';

export type Control = 'prepare' | 'start' | 'stop' | 'engine' | 'clear' | 'reset' | 'close';

const TRANSITIONS: Record<State, Partial<Record<Event, State>>> = {
  idle: { prepare: 'preparing', engineChanged: 'idle' },
  preparing: { prepared: 'ready', prepareFailed: 'idle' },
  ready: { start: 'starting', engineChanged: 'idle', lost: 'idle' },
  starting: { started: 'running', startFailed: 'ready', ended: 'ready' },
  running: { stop: 'stopping', ended: 'ready' },
  stopping: { ended: 'ready' },
  error: { reset: 'idle' },
};

/** The state after `event`, or null when `state` does not accept it. */
export function next(state: State, event: Event): State | null {
  if (event === 'fail') return 'error';
  return TRANSITIONS[state][event] ?? null;
}

/** The controls each state enables. */
export const CONTROLS: Record<State, readonly Control[]> = {
  idle: ['prepare', 'engine', 'close'],
  preparing: ['close'],
  ready: ['start', 'engine', 'clear', 'close'],
  starting: ['close'],
  running: ['stop', 'clear', 'close'],
  stopping: ['close'],
  error: ['reset', 'close'],
};
