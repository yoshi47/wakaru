import { describe, expect, it } from 'vitest';
import { CONTROLS, isFirstRun, next, type Control, type State } from '../src/sidepanel/state';

describe('next', () => {
  it.each<[State, Parameters<typeof next>[1], State]>([
    // Prepared by itself when nothing needs downloading.
    ['idle', 'prepare', 'preparing'],
    // 開始 before that: it prepares first, then starts.
    ['idle', 'start', 'preparing'],
    ['preparing', 'prepared', 'ready'],
    ['preparing', 'prepareFailed', 'idle'],
    ['ready', 'start', 'starting'],
    ['starting', 'started', 'running'],
    ['starting', 'startFailed', 'ready'],
    ['running', 'stop', 'stopping'],
    ['stopping', 'ended', 'ready'],
    // The tab closed, or its capture ended: no stop click.
    ['running', 'ended', 'ready'],
    ['starting', 'ended', 'ready'],
    ['ready', 'engineChanged', 'idle'],
    ['idle', 'engineChanged', 'idle'],
    ['error', 'engineChanged', 'idle'],
    ['ready', 'lost', 'idle'],
    // 開始 after an error prepares again and starts.
    ['error', 'start', 'preparing'],
  ])('%s --%s--> %s', (from, event, to) => {
    expect(next(from, event)).toBe(to);
  });

  it.each<State>(['idle', 'preparing', 'ready', 'starting', 'running', 'stopping', 'error'])('%s --fail--> error', (from) => {
    expect(next(from, 'fail')).toBe('error');
  });

  it.each<[State, Parameters<typeof next>[1]]>([
    // A second click while starting would capture the tab twice.
    ['starting', 'start'],
    ['running', 'start'],
    ['preparing', 'start'],
    // The engine stays as it is while translating (dispose() would race the job in progress).
    ['running', 'engineChanged'],
    ['preparing', 'engineChanged'],
    ['ready', 'prepare'],
    ['error', 'prepare'],
  ])('ignores %s --%s', (from, event) => {
    expect(next(from, event)).toBeNull();
  });
});

describe('CONTROLS', () => {
  it.each<[State, Control[]]>([
    ['idle', ['start', 'engine', 'clear', 'close']],
    ['preparing', ['close']],
    ['ready', ['start', 'engine', 'clear', 'close']],
    ['starting', ['close']],
    ['running', ['stop', 'clear', 'close']],
    ['stopping', ['close']],
    ['error', ['start', 'engine', 'clear', 'close']],
  ])('%s enables %j', (state, controls) => {
    expect([...CONTROLS[state]].sort()).toEqual([...controls].sort());
  });

  it('enables a control only where its event is accepted', () => {
    const eventOf: Partial<Record<Control, Parameters<typeof next>[1]>> = {
      start: 'start',
      stop: 'stop',
      engine: 'engineChanged',
    };
    for (const state of Object.keys(CONTROLS) as State[]) {
      for (const [control, event] of Object.entries(eventOf)) {
        expect(CONTROLS[state].includes(control as Control), `${state} ${control}`).toBe(next(state, event!) !== null);
      }
    }
  });
});

describe('isFirstRun', () => {
  it('is true only in idle, with PLaMo, and without the model', () => {
    expect(isFirstRun('idle', 'plamo', true)).toBe(true);
    expect(isFirstRun('idle', 'plamo', false)).toBe(false);
    expect(isFirstRun('idle', 'chrome', true)).toBe(false);
    expect(isFirstRun('ready', 'plamo', true)).toBe(false);
    expect(isFirstRun('error', 'plamo', true)).toBe(false);
  });
});
