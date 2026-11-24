import { describe, expect, it } from 'vitest';
import { StallFinalizer } from '../src/asr/stallFinalizer';

const make = () => new StallFinalizer({ stallMs: 1200 });

describe('StallFinalizer', () => {
  it('finalizes an interim that has not changed for stallMs', () => {
    const s = make();
    s.update('ja', 1, '来週のリリース', 0);
    expect(s.tick(1199)).toEqual([]);
    expect(s.tick(1200)).toEqual([
      { final: { lang: 'ja', text: '来週のリリース', at: 0, synthetic: true }, generation: 1 },
    ]);
  });

  it('measures stallMs from the last change of the interim, and stamps the final with that time', () => {
    const s = make();
    s.update('ja', 1, '来週', 0);
    s.update('ja', 1, '来週のリリース', 1000);
    s.update('ja', 1, '来週のリリース', 1500);
    expect(s.tick(2199)).toEqual([]);
    expect(s.tick(2200).map((r) => r.final.at)).toEqual([1000]);
  });

  it('finalizes each stalled interim only once', () => {
    const s = make();
    s.update('en', 1, 'Sure', 0);
    expect(s.tick(1200)).toHaveLength(1);
    expect(s.tick(5000)).toEqual([]);
  });

  it('ignores later updates from a generation it finalized (the recognizer is being restarted)', () => {
    const s = make();
    s.update('en', 1, 'Sure', 0);
    s.tick(1200);
    s.update('en', 1, 'Sure', 1300);
    expect(s.tick(5000)).toEqual([]);

    s.update('en', 2, 'we are planning', 5000);
    expect(s.tick(6200)).toEqual([
      { final: { lang: 'en', text: 'we are planning', at: 5000, synthetic: true }, generation: 2 },
    ]);
  });

  it('ignores updates from a generation older than the current one', () => {
    const s = make();
    s.update('ja', 2, 'はい', 0);
    s.update('ja', 1, '古い途中経過', 100);
    expect(s.tick(1200)).toEqual([
      { final: { lang: 'ja', text: 'はい', at: 0, synthetic: true }, generation: 2 },
    ]);
  });

  it('clears the interim when a real final comes, so the sentence is not finalized twice', () => {
    const s = make();
    s.update('ja', 1, '承知しました', 0);
    expect(s.onRealFinal('ja', 1)).toBe(true);
    expect(s.tick(5000)).toEqual([]);
  });

  it('rejects a real final from a generation it already finalized', () => {
    const s = make();
    s.update('ja', 1, '承知しました', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 1)).toBe(false);
    expect(s.onRealFinal('ja', 2)).toBe(true);
  });

  it('keeps the two languages apart', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.update('en', 1, 'Hi', 600);
    s.onRealFinal('en', 1);
    expect(s.tick(1200).map((r) => r.final.lang)).toEqual(['ja']);
  });

  it('does not finalize an empty interim', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.update('ja', 1, '', 100);
    expect(s.tick(5000)).toEqual([]);
  });
});
