import { describe, expect, it } from 'vitest';
import { Arbiter, type Final, type LangDetect } from '../src/asr/arbiter';
import type { Lang } from '../src/shared/lang';

// LanguageDetector results measured on Chrome (Beta 159 on 2026-11-20, 157 in Task 1).
const DETECTED: Record<string, { lang: string; confidence: number }> = {
  'Schedu schedule': { lang: 'de', confidence: 0.81 },
  'Ok Google': { lang: 'en', confidence: 0.94 },
  'Sure we are planning to ship the new feature on Wednesday': { lang: 'en', confidence: 1 },
  Okay: { lang: 'en', confidence: 0.64 },
  'Bakari Masta Auto de Surah conico YouTube': { lang: 'es', confidence: 0.69 },
  'Bakari Masta Auto de Surah unique': { lang: 'es', confidence: 0.25 },
  Yeah: { lang: 'en', confidence: 0.86 },
};

// Made-up values for the rules that the measured cases do not reach.
const MADE_UP: Record<string, { lang: string; confidence: number }> = {
  'abcd efgh': { lang: 'en', confidence: 1 },
  'one two three': { lang: 'en', confidence: 0.7 },
  'one two three four': { lang: 'en', confidence: 0.7 },
  // Overlap scenarios (Task 3.5). Correct English sentences measured en 1.00 elsewhere.
  'Planning to ship the new feature on Wednesday': { lang: 'en', confidence: 1 },
  'Most of the tests are done but we still need to check the payment flow': { lang: 'en', confidence: 1 },
  Disney: { lang: 'en', confidence: 0.5 },
};

const RELEASE = '来週のリリースについてスケジュールを確認させてください';

function setup() {
  let time = 0;
  const detected: string[] = [];
  const detect: LangDetect = async (text) => {
    detected.push(text);
    const result = DETECTED[text] ?? MADE_UP[text];
    if (!result) throw new Error(`no stub for "${text}"`);
    return result;
  };
  const arbiter = new Arbiter({
    windowMs: 800,
    enMinConfidence: 0.9,
    enShortMinConfidence: 0.6,
    detect,
    now: () => time,
  });
  const push = (lang: Lang, text: string, at: number = time) =>
    arbiter.push({ lang, text, at, synthetic: false });
  const advance = (ms: number) => {
    time += ms;
  };
  return { arbiter, push, advance, detected, at: () => time };
}

/** Pushes the finals at time 0, then lets the window close and decides it. */
async function decideOne(finals: [Lang, string][]) {
  const { arbiter, push, advance } = setup();
  for (const [lang, text] of finals) push(lang, text);
  advance(800);
  const decisions = await arbiter.flushDue();
  expect(decisions).toHaveLength(1);
  return decisions[0]!;
}

const texts = (finals: Final[]) => finals.map((f) => f.text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Arbiter decisions (cases measured in the plan)', () => {
  it('takes ja and rejects a misrecognized en (de 0.81)', async () => {
    const d = await decideOne([['ja', RELEASE], ['en', 'Schedu schedule']]);
    expect(d.lang).toBe('ja');
    expect(d.text).toBe(RELEASE);
    expect(texts(d.rejected)).toEqual(['Schedu schedule']);
  });

  it('takes the longer one when both are valid (ja vs en 0.94)', async () => {
    const d = await decideOne([['ja', RELEASE], ['en', 'Ok Google']]);
    expect(d.lang).toBe('ja');
    expect(texts(d.rejected)).toEqual(['Ok Google']);
  });

  it('takes en when only en came and it is confident', async () => {
    const text = 'Sure we are planning to ship the new feature on Wednesday';
    const d = await decideOne([['en', text]]);
    expect(d.lang).toBe('en');
    expect(d.text).toBe(text);
  });

  it('uses the normal threshold for a short en when ja is not empty (OK vs Okay 0.64)', async () => {
    const d = await decideOne([['ja', 'OK'], ['en', 'Okay']]);
    expect(d.lang).toBe('ja');
    expect(d.text).toBe('OK');
  });

  it('takes a lone ja', async () => {
    const d = await decideOne([['ja', 'はい']]);
    expect(d.lang).toBe('ja');
    expect(d.text).toBe('はい');
  });

  it('takes nothing when the only en is not English (es 0.69)', async () => {
    const d = await decideOne([['en', 'Bakari Masta Auto de Surah conico YouTube']]);
    expect(d.lang).toBeNull();
    expect(d.text).toBe('');
    expect(texts(d.rejected)).toEqual(['Bakari Masta Auto de Surah conico YouTube']);
  });

  it('takes ja over an en that is not English (es 0.25)', async () => {
    const d = await decideOne([
      ['ja', 'わかりました後ですらに共有します'],
      ['en', 'Bakari Masta Auto de Surah unique'],
    ]);
    expect(d.lang).toBe('ja');
    expect(d.text).toBe('わかりました後ですらに共有します');
  });

  it('takes a short en with the lower threshold when ja is empty (Yeah 0.86)', async () => {
    const d = await decideOne([['en', 'Yeah']]);
    expect(d.lang).toBe('en');
    expect(d.text).toBe('Yeah');
  });

  it('drops the opposite language within windowMs of the last decision (Okay 500ms after ja)', async () => {
    const { arbiter, push, advance, at } = setup();
    push('ja', 'はい');
    advance(800);
    const [first] = await arbiter.flushDue();
    expect(first?.lang).toBe('ja');
    expect(first?.decidedAt).toBe(at());

    advance(500);
    push('en', 'Okay');
    advance(800);
    const [second] = await arbiter.flushDue();
    expect(second?.lang).toBeNull();
    expect(texts(second?.rejected ?? [])).toEqual(['Okay']);
  });

  it('joins two ja finals in the same window without a space', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', '来週');
    advance(300);
    push('ja', 'のリリース');
    advance(500);
    const [d] = await arbiter.flushDue();
    expect(d?.lang).toBe('ja');
    expect(d?.text).toBe('来週のリリース');
  });
});

describe('Arbiter rule against the opposite language right after a decision', () => {
  it('keeps the opposite language that comes more than windowMs after the window closed', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(800);
    await arbiter.flushDue();
    // The window closed at 800: 1600 is still within windowMs, 1601 is not.
    advance(800);
    push('en', 'Okay');
    advance(800);
    expect((await arbiter.flushDue())[0]?.lang).toBeNull();
    advance(1);
    push('en', 'Okay');
    advance(800);
    expect((await arbiter.flushDue())[0]?.lang).toBe('en');
  });

  it('keeps the same language right after a decision', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(800);
    await arbiter.flushDue();
    push('ja', '了解です');
    advance(800);
    expect((await arbiter.flushDue())[0]?.text).toBe('了解です');
  });

  it('does not let a slow detection swallow a reply in the other language', async () => {
    let time = 0;
    const arbiter = new Arbiter({
      windowMs: 800,
      enMinConfidence: 0.9,
      enShortMinConfidence: 0.6,
      detect: async (text) => {
        if (text === 'Sure we are planning') time += 3000; // detection of the first window takes 3s
        return { lang: 'en', confidence: 1 };
      },
      now: () => time,
    });
    arbiter.push({ lang: 'en', text: 'Sure we are planning', at: 0, synthetic: false });
    time = 800;
    const [first] = await arbiter.flushDue();
    expect(first?.decidedAt).toBe(3800);
    // A Japanese reply 2s after the first window closed, decided after the slow detection.
    arbiter.push({ lang: 'ja', text: '了解です', at: 2800, synthetic: false });
    time = 4000;
    expect((await arbiter.flushDue())[0]?.lang).toBe('ja');
  });
});

describe('Arbiter judge details', () => {
  it('takes ja when both are valid and have the same number of letters', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', '一二三四五六七八');
    push('en', 'abcd efgh');
    advance(800);
    const [d] = await arbiter.flushDue();
    expect(d?.lang).toBe('ja');
  });

  it('uses the lower threshold for up to 3 English words only', async () => {
    expect((await decideOne([['en', 'one two three']])).lang).toBe('en');
    expect((await decideOne([['en', 'one two three four']])).lang).toBeNull();
  });
});

describe('Arbiter with overlapping speech (Task 3.5 log)', () => {
  it('takes both when an English reply overlaps the end of a Japanese utterance', async () => {
    const { arbiter, push, advance } = setup();
    push('en', 'Planning to ship the new feature on Wednesday', 0);
    push('ja', RELEASE, 278);
    advance(800);
    const ds = await arbiter.flushDue();
    expect(ds.map((d) => [d.lang, d.text])).toEqual([
      ['en', 'Planning to ship the new feature on Wednesday'],
      ['ja', RELEASE],
    ]);
  });

  it('takes both when a Japanese reply overlaps the end of an English utterance', async () => {
    const { arbiter, push, advance } = setup();
    push('en', 'Most of the tests are done but we still need to check the payment flow', 0);
    push('ja', 'のレビューは田中さんにお願いしています', 500);
    advance(800);
    expect((await arbiter.flushDue()).map((d) => d.lang)).toEqual(['en', 'ja']);
  });

  it('takes one when the other side is a misrecognition (ja-ja overlap, en "Disney")', async () => {
    const d = await decideOne([
      ['en', 'Disney'],
      ['ja', 'すみませんちょっと音声を入れれば解決しそうですね'],
    ]);
    expect(d.lang).toBe('ja');
  });

  it('takes one when the Japanese side is shorter than 4 kana or kanji', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'そうだ');
    push('en', 'Most of the tests are done but we still need to check the payment flow');
    advance(800);
    expect((await arbiter.flushDue()).map((d) => d.lang)).toEqual(['en']);
  });

  it('does not count Latin letters on the Japanese side as a real utterance', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'WEB API OK');
    push('en', 'Most of the tests are done but we still need to check the payment flow');
    advance(800);
    expect((await arbiter.flushDue()).map((d) => d.lang)).toEqual(['en']);
  });

  it('does not count katakana as a real Japanese utterance (English spelled in katakana)', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'モストオブザテストアーダン');
    push('en', 'Most of the tests are done but we still need to check the payment flow');
    advance(800);
    expect((await arbiter.flushDue()).map((d) => d.lang)).toEqual(['en']);
  });

  it('rejects nothing when it takes both', async () => {
    const { arbiter, push, advance } = setup();
    push('en', 'Planning to ship the new feature on Wednesday', 0);
    push('ja', RELEASE, 278);
    advance(800);
    expect((await arbiter.flushDue()).flatMap((d) => d.rejected)).toEqual([]);
  });

  it('after taking both, drops a short word in the language opposite to the last final', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', RELEASE, 0);
    push('en', 'Planning to ship the new feature on Wednesday', 300);
    advance(800);
    await arbiter.flushDue();
    // The window closed at 300, when the second language came: 900 is within windowMs.
    push('ja', 'OK', 900);
    advance(1000);
    expect((await arbiter.flushDue())[0]?.lang).toBeNull();
  });

  it('keeps a real utterance in the other language right after a decision', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(800);
    await arbiter.flushDue();
    advance(300);
    push('en', 'Sure we are planning to ship the new feature on Wednesday');
    advance(800);
    expect((await arbiter.flushDue())[0]?.lang).toBe('en');
  });
});

describe('Arbiter windows', () => {
  it('joins two en finals in the same window with a space', async () => {
    const { arbiter, push, advance } = setup();
    push('en', 'Sure we are planning');
    advance(300);
    push('en', 'to ship the new feature on Wednesday');
    advance(500);
    const [d] = await arbiter.flushDue();
    expect(d?.text).toBe('Sure we are planning to ship the new feature on Wednesday');
  });

  it('keeps the window open until windowMs has passed since the first final', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(799);
    expect(await arbiter.flushDue()).toEqual([]);
    advance(1);
    expect(await arbiter.flushDue()).toHaveLength(1);
  });

  it('closes the window as soon as both languages are in it', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'OK');
    advance(100);
    push('en', 'Okay');
    const [d] = await arbiter.flushDue();
    expect(d?.text).toBe('OK');
  });

  it('starts a new window for a final that comes windowMs after the first', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(800);
    push('ja', '了解です');
    const decisions = await arbiter.flushDue();
    expect(decisions.map((d) => d.text)).toEqual(['はい']);
    advance(800);
    expect((await arbiter.flushDue()).map((d) => d.text)).toEqual(['了解です']);
  });

  it('measures from firstAt, the time of the first final', async () => {
    const { arbiter, push, advance } = setup();
    advance(1000);
    push('ja', 'はい');
    advance(900);
    const [d] = await arbiter.flushDue();
    expect(d?.firstAt).toBe(1000);
    expect(d?.decidedAt).toBe(1900);
  });

  it('decides windows in the order they closed even when flushDue calls overlap', async () => {
    let time = 0;
    const order: string[] = [];
    const resolvers: (() => void)[] = [];
    const arbiter = new Arbiter({
      windowMs: 800,
      enMinConfidence: 0.9,
      enShortMinConfidence: 0.6,
      // The first detection is slow: the second window must still be decided after it.
      detect: (text) =>
        new Promise((resolve) => {
          order.push(`detect ${text}`);
          resolvers.push(() => resolve({ lang: 'en', confidence: 1 }));
        }),
      now: () => time,
    });
    arbiter.push({ lang: 'en', text: 'first one', at: 0, synthetic: false });
    time = 800;
    const firstCall = arbiter.flushDue();
    arbiter.push({ lang: 'en', text: 'second one', at: 2000, synthetic: false });
    time = 2800;
    const secondCall = arbiter.flushDue();

    await settle();
    expect(order).toEqual(['detect first one']);
    resolvers[0]!();
    const first = await firstCall;
    await settle();
    expect(order).toEqual(['detect first one', 'detect second one']);
    resolvers[1]!();
    const second = await secondCall;
    expect(first.map((d) => d.text)).toEqual(['first one']);
    expect(second.map((d) => d.text)).toEqual(['second one']);
  });

  it('treats an en candidate as invalid when detection fails', async () => {
    const d = await decideOne([['en', 'no stub for this']]);
    expect(d.lang).toBeNull();
  });

  it('ignores empty finals', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', '');
    advance(800);
    expect(await arbiter.flushDue()).toEqual([]);
  });
});

describe('Arbiter.flushAll', () => {
  it('decides the open window without waiting for windowMs', async () => {
    const { arbiter, push, advance } = setup();
    push('ja', 'はい');
    advance(100);
    const decisions = await arbiter.flushAll();
    expect(decisions.map((d) => d.text)).toEqual(['はい']);
    expect(await arbiter.flushAll()).toEqual([]);
  });
});
