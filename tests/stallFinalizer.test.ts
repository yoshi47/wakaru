import { describe, expect, it } from 'vitest';
import type { Lang } from '../src/shared/lang';
import { StallFinalizer } from '../src/asr/stallFinalizer';

function make() {
  const discarded: [Lang, string][] = [];
  const s = new StallFinalizer({ stallMs: 1200, onDiscard: (lang, text) => discarded.push([lang, text]) });
  return Object.assign(s, { discarded });
}

describe('StallFinalizer', () => {
  it('finalizes an interim that has not changed for stallMs', () => {
    const s = make();
    s.update('ja', 1, '来週のリリース', 0);
    expect(s.tick(1199)).toEqual([]);
    expect(s.tick(1200)).toEqual([{ lang: 'ja', text: '来週のリリース', at: 0, synthetic: true }]);
  });

  it('measures stallMs from the last change of the interim, and stamps the final with that time', () => {
    const s = make();
    s.update('ja', 1, '来週', 0);
    s.update('ja', 1, '来週のリリース', 1000);
    s.update('ja', 1, '来週のリリース', 1500);
    expect(s.tick(2199)).toEqual([]);
    expect(s.tick(2200).map((f) => f.at)).toEqual([1000]);
  });

  it('finalizes each stalled interim only once', () => {
    const s = make();
    s.update('en', 1, 'Sure', 0);
    expect(s.tick(1200)).toHaveLength(1);
    expect(s.tick(5000)).toEqual([]);
  });

  it('ignores updates from a generation older than the current one', () => {
    const s = make();
    s.update('ja', 2, 'はい', 0);
    s.update('ja', 1, '古い途中経過', 100);
    expect(s.tick(1200)).toEqual([{ lang: 'ja', text: 'はい', at: 0, synthetic: true }]);
  });

  it('clears the interim when a real final comes, so the sentence is not finalized twice', () => {
    const s = make();
    s.update('ja', 1, '承知しました', 0);
    expect(s.onRealFinal('ja', 1, '承知 し まし た', 300)).toBe('承知 し まし た');
    expect(s.tick(5000)).toEqual([]);
  });

  it('ignores an empty real final', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    expect(s.onRealFinal('ja', 1, ' ', 100)).toBeNull();
    expect(s.tick(1300)).toHaveLength(1);
  });

  it('does not finalize an empty interim', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.update('ja', 1, '', 100);
    expect(s.tick(5000)).toEqual([]);
  });
});

describe('StallFinalizer and the other language', () => {
  it('waits until the other language has been quiet for stallMs', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.update('en', 1, 'Hi', 0);
    s.update('en', 1, 'Hi', 500); // unchanged: not new speech
    expect(s.tick(1199)).toEqual([]);
    expect(s.tick(1200).map((f) => f.lang)).toEqual(['ja', 'en']);
  });

  it('drops the stuck start of the other language’s speech once that speech ends', () => {
    const s = make();
    // Task 3: the ja side showed "No" at the start of "No worries…" and never updated it.
    s.update('ja', 1, 'No', 0);
    const words = ['No', 'No worries', 'No worries I said', 'No worries I said the API rate limit'];
    words.forEach((w, i) => s.update('en', 1, w, 500 + i * 1000));
    expect(s.tick(4699)).toEqual([]);
    expect(s.tick(4700).map((f) => f.lang)).toEqual(['en']);
    expect(s.discarded).toEqual([['ja', 'No']]);
  });

  it('drops the stuck start even when the other language’s final comes late', () => {
    const s = make();
    s.update('ja', 1, 'No', 0);
    s.update('en', 1, 'No worries I said', 500);
    s.update('en', 1, 'No worries I said the API rate limit', 1500);
    expect(s.tick(2700).map((f) => [f.lang, f.text])).toEqual([['en', 'No worries I said the API rate limit']]);
    expect(s.discarded).toEqual([['ja', 'No']]);
    // The late real final of the en side repeats what was finalized: cut off, nothing left.
    expect(s.onRealFinal('en', 1, 'No worries I said the API rate limit', 3100)).toBeNull();
  });

  it('flush() discards the interim while the other language is being heard', () => {
    const s = make();
    s.update('ja', 1, 'EX', 0);
    s.update('en', 1, 'Exactly can you take', 800);
    expect(s.flush('ja', 1, 1000)).toBeNull();
    expect(s.discarded).toEqual([['ja', 'EX']]);
  });

  it('counts a real final as hearing that language', () => {
    const s = make();
    s.update('ja', 1, 'うん', 0);
    s.onRealFinal('en', 1, 'Sure', 500);
    expect(s.tick(1200)).toEqual([]);
    expect(s.tick(1700)).toEqual([]);
    expect(s.discarded).toEqual([['ja', 'うん']]);
  });
});

describe('StallFinalizer after finalizing (the recognizer keeps running)', () => {
  it('drops a late real final that only repeats the finalized interim', () => {
    const s = make();
    s.update('ja', 1, 'WEB版の方ですモバイルは来月対応予定です', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 1, ' WEB 版 の 方 です モバイル は 来月 対応 予定 です', 2000)).toBeNull();
    expect(s.tick(9000)).toEqual([]);
  });

  // DualRecognizer sends the interim after each final, which is '' once the result closed: kept
  // as the interim, what follows the finalized start was wiped out by it (lost in the meeting log
  // and in dev/overlap.json's monologue-ja).
  it('passes on what follows the finalized start as the final', () => {
    const s = make();
    s.update('ja', 1, '発注者取り消し機能なんですけど', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 1, '発注 者 取り消し 機能 なん です けど クライアント 側 の UI と', 3000)).toBe(
      'クライアント 側 の UI と',
    );
    s.update('ja', 1, '', 3000);
    expect(s.tick(9000)).toEqual([]);
  });

  it('passes on the final as it is when it does not repeat the finalized start', () => {
    const s = make();
    s.update('en', 1, 'I', 0);
    s.tick(1200);
    expect(s.onRealFinal('en', 1, 'Okay so I priority QA gets', 3000)).toBe('Okay so I priority QA gets');
  });

  it('does not count a final that only repeats the finalized start as speech', () => {
    // Counted, it would hold up the ja reply, then drop it as the stuck start of English speech.
    const s = make();
    s.update('en', 1, 'OK', 0);
    expect(s.tick(1200)).toHaveLength(1);
    s.update('ja', 1, 'はい', 1500);
    expect(s.onRealFinal('en', 1, 'OK', 1700)).toBeNull();
    expect(s.tick(2700)).toEqual([{ lang: 'ja', text: 'はい', at: 1500, synthetic: true }]);
    expect(s.discarded).toEqual([]);
  });

  it('cuts the finalized start off later interims', () => {
    const s = make();
    s.update('en', 1, 'Yeah', 0);
    s.tick(1200);
    s.update('en', 1, 'Yeah I think so', 2000);
    expect(s.tick(3200)).toEqual([{ lang: 'en', text: 'I think so', at: 2000, synthetic: true }]);
  });

  it('drops Latin letters that follow the finalized start on the ja side', () => {
    const s = make();
    // Task 1: the stuck ja result came back with the first word of the next English utterance.
    s.update('ja', 1, 'WEB版の方です', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 1, 'WEB 版 の 方 です the', 2000)).toBeNull();
    s.update('en', 1, 'That makes sense', 2100);
    s.onRealFinal('en', 1, 'That makes sense', 2900);
    expect(s.tick(4100).map((f) => f.lang)).toEqual([]);
    expect(s.discarded).toEqual([['ja', 'the']]);
  });

  it('drops what follows a start discarded as the other language’s, when its final comes late', () => {
    const s = make();
    // Task 3: the ja side stuck at "No" during "No worries…", then sent its own late final.
    s.update('ja', 1, 'No', 0);
    s.update('en', 1, 'No worries I said the API rate limit', 500);
    s.tick(1700);
    expect(s.discarded).toEqual([['ja', 'No']]);
    expect(s.onRealFinal('ja', 1, 'No ウォーリーズ', 5600)).toBeNull();
    expect(s.discarded).toEqual([
      ['ja', 'No'],
      ['ja', 'ウォーリーズ'],
    ]);
  });

  it('does not count dropped Latin letters as Japanese speech', () => {
    // Counted, they would hold up the English reply, then drop it as a stuck start.
    const s = make();
    s.update('ja', 1, 'WEB版の方です', 0);
    s.tick(1200);
    s.update('en', 1, 'Okay', 1900);
    expect(s.onRealFinal('ja', 1, 'WEB 版 の 方 です the', 2000)).toBeNull();
    expect(s.tick(3100)).toEqual([{ lang: 'en', text: 'Okay', at: 1900, synthetic: true }]);
  });

  it('passes on katakana that follows the finalized start on the ja side', () => {
    const s = make();
    s.update('ja', 1, 'あとは', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 1, 'あと は テスト', 2000)).toBe('テスト');
  });

  it('treats an interim with a different start as the next utterance', () => {
    const s = make();
    s.update('ja', 1, 'No', 0);
    s.tick(1200);
    s.update('ja', 1, 'なるほど', 2000);
    expect(s.tick(3200)).toEqual([{ lang: 'ja', text: 'なるほど', at: 2000, synthetic: true }]);
  });

  it('compares English by whole words: a stuck "Yo" is not the start of "You know"', () => {
    const s = make();
    s.update('en', 1, 'Yo', 0);
    s.tick(1200);
    expect(s.onRealFinal('en', 1, 'You know what', 2000)).toBe('You know what');
  });

  it('starts clean in a new generation', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.tick(1200);
    expect(s.onRealFinal('ja', 2, 'はい', 2000)).toBe('はい');
  });
});

describe('StallFinalizer.flush / flushAll', () => {
  it('flush() finalizes the interim of an ended recognizer at once, only for its generation', () => {
    const s = make();
    s.update('ja', 3, 'ウェブ版の方です', 100);
    expect(s.flush('ja', 2, 5000)).toBeNull();
    expect(s.flush('ja', 3, 5000)).toEqual({ lang: 'ja', text: 'ウェブ版の方です', at: 100, synthetic: true });
    expect(s.flush('ja', 3, 5000)).toBeNull();
    expect(s.tick(5000)).toEqual([]);
  });

  it('flushAll() finalizes the interims left in both languages', () => {
    const s = make();
    s.update('ja', 1, 'はい', 0);
    s.update('en', 4, 'Okay', 50);
    expect(s.flushAll().map((f) => [f.lang, f.text])).toEqual([
      ['ja', 'はい'],
      ['en', 'Okay'],
    ]);
    expect(s.flushAll()).toEqual([]);
  });
});
