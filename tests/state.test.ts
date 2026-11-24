import { describe, expect, it } from 'vitest';
import { CONTROLS, next, type Control, type State } from '../src/sidepanel/state';

describe('next', () => {
  it.each<[State, Parameters<typeof next>[1], State]>([
    ['idle', 'prepare', 'preparing'],
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
    ['ready', 'lost', 'idle'],
    ['error', 'reset', 'idle'],
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
    // The engine stays as it is while translating (dispose() would race the job in progress).
    ['running', 'engineChanged'],
    ['preparing', 'engineChanged'],
    ['idle', 'start'],
    ['error', 'start'],
    ['ready', 'reset'],
  ])('ignores %s --%s', (from, event) => {
    expect(next(from, event)).toBeNull();
  });
});

describe('CONTROLS', () => {
  it.each<[State, Control[]]>([
    ['idle', ['prepare', 'engine', 'close']],
    ['preparing', ['close']],
    ['ready', ['start', 'engine', 'clear', 'close']],
    ['starting', ['close']],
    ['running', ['stop', 'clear', 'close']],
    ['stopping', ['close']],
    ['error', ['reset', 'close']],
  ])('%s enables %j', (state, controls) => {
    expect([...CONTROLS[state]].sort()).toEqual([...controls].sort());
  });

  it('enables a control only where its event is accepted', () => {
    const eventOf: Partial<Record<Control, Parameters<typeof next>[1]>> = {
      prepare: 'prepare',
      start: 'start',
      stop: 'stop',
      engine: 'engineChanged',
      reset: 'reset',
    };
    for (const state of Object.keys(CONTROLS) as State[]) {
      for (const [control, event] of Object.entries(eventOf)) {
        expect(CONTROLS[state].includes(control as Control), `${state} ${control}`).toBe(next(state, event!) !== null);
      }
    }
  });
});
