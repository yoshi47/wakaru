import { describe, expect, it } from 'vitest';
import { Paragrapher, type ParagrapherOptions, type Piece } from '../src/asr/paragrapher';
import type { Lang } from '../src/shared/lang';

function make(opts: Partial<ParagrapherOptions> = {}) {
  const silences: number[] = [];
  const p = new Paragrapher({
    maxGapMs: 3000,
    minGapMs: 1000,
    maxTokens: 80,
    merge: true,
    onSilence: (ms) => silences.push(ms),
    ...opts,
  });
  return Object.assign(p, { silences });
}

const piece = (lang: Lang, text: string, firstAt: number): Piece => ({ lang, text, firstAt });

/** Interims changing every 200ms from `from` to `to`: someone speaking. */
function speak(p: Paragrapher, from: number, to: number): void {
  for (let t = from; t <= to; t += 200) p.heard(t);
}

describe('Paragrapher', () => {
  it('adds the pieces of one speaker to one paragraph (the meeting log, #4 to #8)', () => {
    const p = make();
    // Pauses of up to 1.5s between the pieces: shorter than the gap of a paragraph that short.
    speak(p, 0, 2000);
    const a = p.add(piece('en', 'All right I finished the pr and then', 2000));
    speak(p, 3000, 4000);
    const b = p.add(piece('en', 'I realized that', 4000));
    speak(p, 5500, 7000);
    const c = p.add(piece('en', 'Like the', 7000));
    speak(p, 8000, 12000);
    const d = p.add(piece('en', 'Was not the only issue that was happening so like it was happening on', 12000));
    expect([a, b, c, d].map((u) => [u.kind, u.paragraph.key])).toEqual([
      ['new', 1],
      ['append', 1],
      ['append', 1],
      ['append', 1],
    ]);
    expect(d.paragraph.text).toBe(
      'All right I finished the pr and then I realized that Like the Was not the only issue that was happening so like it was happening on',
    );
    expect(d.closed).toBeNull();
  });

  it('joins Japanese pieces without spaces', () => {
    const p = make();
    p.add(piece('ja', 'はいえっと発注者取り消し機能なんですけど', 0));
    expect(p.add(piece('ja', 'を成功して進めてます以上です', 1000)).paragraph.text).toBe(
      'はいえっと発注者取り消し機能なんですけどを成功して進めてます以上です',
    );
  });

  it('starts a new paragraph after a long silence', () => {
    const p = make();
    speak(p, 0, 2000);
    p.add(piece('en', "That's it for my end thank you", 2000));
    speak(p, 6000, 8000);
    const u = p.add(piece('en', 'Good morning everyone for me today', 8000));
    expect([u.kind, u.paragraph.key, u.closed]).toEqual(['new', 2, 'gap']);
    expect(p.silences).toEqual([4000]);
  });

  it('keeps maxGapMs up to half the limit, then closes after a shorter silence as it gets longer', () => {
    /** A paragraph of `chars` characters (chars / 4 tokens), and whether `silence` closes it. */
    const closes = (chars: number, silence: number) => {
      const p = make();
      p.add(piece('en', 'w'.repeat(chars), 0));
      p.heard(100);
      p.heard(100 + silence);
      return p.add(piece('en', 'next', silence + 500)).closed === 'gap';
    };
    // 38 tokens, as the paragraph of dev/overlap.json's monologue-en: a 1.8s pause measured 2117ms.
    expect(closes(152, 2117)).toBe(false);
    expect(closes(152, 3000)).toBe(true);
    // 60 tokens: halfway from maxGapMs to minGapMs (2000ms).
    expect(closes(240, 1999)).toBe(false);
    expect(closes(240, 2000)).toBe(true);
    // 76 tokens: close to minGapMs (1200ms).
    expect(closes(304, 1199)).toBe(false);
    expect(closes(304, 1200)).toBe(true);
  });

  it('does not take a silence after the piece for one before it (a decision that came late)', () => {
    const p = make();
    p.add(piece('en', 'All right I finished the pr', 0));
    // The next piece's speech ended at 1000, but its decision comes after another silence.
    speak(p, 200, 1000);
    p.heard(5000);
    expect(p.add(piece('en', 'and then I realized that', 1000)).kind).toBe('append');
  });

  it('starts a new paragraph when the language changes, and does not go back to the earlier one', () => {
    const p = make();
    p.add(piece('en', 'And yeah also continue testing on using the devbox', 0));
    const ja = p.add(piece('ja', '発注者取り消し機能なんですけど', 500));
    const en = p.add(piece('en', 'So for me today I will be working on', 1000));
    expect([ja.kind, ja.paragraph.key, ja.closed]).toEqual(['new', 2, 'lang']);
    expect([en.kind, en.paragraph.key, en.closed]).toEqual(['new', 3, 'lang']);
  });

  it('gives a short reply in the other language its own subtitle without closing the paragraph', () => {
    const p = make();
    p.add(piece('en', 'I finished the pr and then', 0));
    const ok = p.add(piece('ja', 'OK', 500));
    const hai = p.add(piece('ja', 'はい', 800));
    const en = p.add(piece('en', 'I realized that it was not the only issue', 1500));
    expect([ok.kind, ok.paragraph.key, ok.closed]).toEqual(['new', 2, null]);
    expect([hai.kind, hai.paragraph.key]).toEqual(['new', 3]);
    expect([en.kind, en.paragraph.key]).toEqual(['append', 1]);
  });

  it('does not let a backchannel close the paragraph, but a real Japanese utterance does', () => {
    const p = make();
    p.add(piece('en', 'I think we should push back the deadline', 0));
    expect(p.add(piece('ja', 'うんうん', 300)).closed).toBeNull();
    expect(p.add(piece('ja', 'そうですね', 600)).closed).toBeNull();
    expect(p.add(piece('en', 'if QA cannot finish by Friday', 900)).kind).toBe('append');
    expect(p.add(piece('ja', 'それで来週お願いします', 1200)).closed).toBe('lang');
  });

  it('closes the paragraph on silence even with a short reply in between', () => {
    const p = make();
    speak(p, 0, 1000);
    p.add(piece('en', 'I finished the pr and then', 1000));
    p.add(piece('ja', 'OK', 1200));
    p.heard(1300);
    p.heard(5000);
    expect(p.add(piece('en', 'Good morning everyone for me today', 5500)).closed).toBe('gap');
  });

  it('opens a paragraph with a short reply when none is open', () => {
    const p = make();
    const ok = p.add(piece('en', 'Okay', 0));
    const ja = p.add(piece('ja', '来週のリリースについて確認させてください', 500));
    expect([ok.kind, ja.closed]).toEqual(['new', 'lang']);
  });

  it('counts a silence ending at the new piece, not one ending at the last piece', () => {
    const atNew = make();
    atNew.add(piece('en', 'I finished the pr', 0));
    atNew.heard(500);
    atNew.heard(4000);
    expect(atNew.add(piece('en', 'and then', 4000)).closed).toBe('gap');

    const atLast = make();
    atLast.heard(0);
    atLast.heard(4000);
    atLast.add(piece('en', 'I finished the pr', 4000));
    expect(atLast.add(piece('en', 'and then', 4500)).kind).toBe('append');
  });

  it('closes a paragraph that one piece took past the limit', () => {
    const p = make();
    p.add(piece('en', 'a'.repeat(400), 0)); // 100 tokens
    expect(p.add(piece('en', 'and then', 100)).closed).toBe('limit');
  });

  it('treats an English reply of up to three words as short', () => {
    const p = make();
    p.add(piece('ja', '来週のリリースについてスケジュールを確認させてください', 0));
    expect(p.add(piece('en', 'Okay', 500)).closed).toBeNull();
    expect(p.add(piece('ja', 'それと決済フローも', 1000)).kind).toBe('append');
  });

  it('starts a new paragraph at the token limit, counting Japanese per character', () => {
    const en = make();
    en.add(piece('en', 'a'.repeat(300), 0)); // 75 tokens
    expect(en.add(piece('en', 'bbbb', 100)).kind).toBe('append'); // 76
    expect(en.add(piece('en', 'c'.repeat(20), 200)).closed).toBe('limit'); // 81

    const ja = make();
    ja.add(piece('ja', 'あ'.repeat(75), 0));
    expect(ja.add(piece('ja', 'い'.repeat(6), 100)).closed).toBe('limit');
  });

  it('starts a new paragraph after close()', () => {
    const p = make();
    p.add(piece('en', 'I finished the pr', 0));
    p.close();
    const u = p.add(piece('en', 'and then', 500));
    expect([u.kind, u.paragraph.key, u.closed]).toEqual(['new', 2, null]);
  });

  it('makes every piece a paragraph of its own without merge, and still reports silences', () => {
    const p = make({ merge: false });
    p.add(piece('en', 'I finished the pr', 0));
    p.heard(100);
    p.heard(2000);
    const u = p.add(piece('en', 'and then', 2500));
    expect([u.kind, u.paragraph.key]).toEqual(['new', 2]);
    expect(p.silences).toEqual([1900]);
  });

  it('returns paragraphs that later pieces do not change', () => {
    const p = make();
    const first = p.add(piece('en', 'I finished the pr', 0));
    p.add(piece('en', 'and then', 500));
    expect(first.paragraph.text).toBe('I finished the pr');
    expect(first.paragraph.pieces).toHaveLength(1);
  });

  it('reports every silence of at least minGapMs, and none before the first speech', () => {
    const p = make();
    p.heard(5000);
    p.heard(5500);
    p.heard(6700);
    p.heard(9900);
    expect(p.silences).toEqual([1200, 3200]);
  });
});
