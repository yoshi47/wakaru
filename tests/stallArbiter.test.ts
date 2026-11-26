import { describe, expect, it } from 'vitest';
import { Arbiter, type Decision } from '../src/asr/arbiter';
import { StallFinalizer } from '../src/asr/stallFinalizer';
import type { Lang } from '../src/shared/lang';

// StallFinalizer and Arbiter together, as the session drives them: interims and real finals come
// in, and every 100ms the stalled interims are pushed and the closed windows decided. The
// timelines follow the Task 3 log on Chrome 157, where the other language's recognizer showed the
// first word of an utterance and then stopped updating.

type Event =
  | { at: number; kind: 'interim'; lang: Lang; text: string }
  | { at: number; kind: 'final'; lang: Lang; text: string };

async function run(events: Event[], until: number): Promise<Decision[]> {
  let time = 0;
  const stall = new StallFinalizer({ stallMs: 1200 });
  const arbiter = new Arbiter({
    windowMs: 800,
    enMinConfidence: 0.9,
    enShortMinConfidence: 0.6,
    // The worst case: every English text passes as English.
    detect: async () => ({ lang: 'en', confidence: 1 }),
    now: () => time,
  });
  const decisions: Decision[] = [];
  const queue = [...events].sort((a, b) => a.at - b.at);
  for (time = 0; time <= until; time += 100) {
    while (queue[0] && queue[0].at <= time) {
      const e = queue.shift()!;
      if (e.kind === 'interim') {
        stall.update(e.lang, 1, e.text, e.at);
        continue;
      }
      const passed = stall.onRealFinal(e.lang, 1, e.text, e.at);
      if (passed !== null) arbiter.push({ lang: e.lang, text: passed, at: e.at, synthetic: false });
      // As DualRecognizer does: the interim after a final, '' when the event had only the final.
      stall.update(e.lang, 1, '', e.at);
    }
    for (const final of stall.tick(time)) arbiter.push(final);
    decisions.push(...(await arbiter.flushDue()));
  }
  return decisions.filter((d) => d.lang);
}

const adopted = (ds: Decision[]) => ds.map((d) => `${d.lang} ${d.text}`);

describe('StallFinalizer with Arbiter (Task 3 timelines)', () => {
  it('shows "No worries…" once, not also the "No" the ja side was stuck on', async () => {
    const en = ['No', 'No worries I', 'No worries I said the API rate limit', 'No worries I said the API rate limit is causing the'];
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: 'No' },
        ...en.map((text, i): Event => ({ at: 100 + i * 1000, kind: 'interim', lang: 'en', text })),
        { at: 3500, kind: 'final', lang: 'en', text: 'No worries I said the API rate limit is causing the timeout errors' },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual(['en No worries I said the API rate limit is causing the timeout errors']);
  });

  it('shows "その件は…" once, not also the "The Gemin" the en side was stuck on', async () => {
    const ja = ['その', 'その件は一旦持ち', 'その件は一旦持ち帰ってチーム内で', 'その件は一旦持ち帰ってチーム内で検討させてください'];
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'en', text: 'The Gemin' },
        ...ja.map((text, i): Event => ({ at: 200 + i * 1000, kind: 'interim', lang: 'ja', text })),
        { at: 3600, kind: 'final', lang: 'ja', text: 'その件は一旦持ち帰ってチーム内で検討させてください' },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual(['ja その件は一旦持ち帰ってチーム内で検討させてください']);
  });

  // The interim was finalized before the final came, so the final's new tail becomes a row of its
  // own: split, but nothing lost or shown twice.
  it('shows "No worries…" without the stuck "No" when its final comes 1.6s after the last interim', async () => {
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: 'No' },
        { at: 100, kind: 'interim', lang: 'en', text: 'No worries I' },
        { at: 1100, kind: 'interim', lang: 'en', text: 'No worries I said the API rate limit' },
        { at: 2700, kind: 'final', lang: 'en', text: 'No worries I said the API rate limit is causing the timeout errors' },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual(['en No worries I said the API rate limit', 'en is causing the timeout errors']);
  });

  it('shows "No worries…" once when its final never comes', async () => {
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: 'No' },
        { at: 100, kind: 'interim', lang: 'en', text: 'No worries I' },
        { at: 1100, kind: 'interim', lang: 'en', text: 'No worries I said the API rate limit' },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual(['en No worries I said the API rate limit']);
  });

  // dev/overlap.json's monologue-ja: a pause stalled the start, and its final brought the rest.
  it('keeps what a final adds to a stalled start, in the order spoken', async () => {
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: '発注者取り消し機能なんですけど' },
        { at: 2500, kind: 'final', lang: 'ja', text: '発注 者 取り消し 機能 なん です けど クライアント 側 の UI と' },
        { at: 3000, kind: 'interim', lang: 'ja', text: 'あと' },
        { at: 3600, kind: 'final', lang: 'ja', text: 'あと API の 実装 を 進めて います' },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual([
      'ja 発注者取り消し機能なんですけど',
      'ja クライアント 側 の UI と',
      'ja あと API の 実装 を 進めて います',
    ]);
  });

  it('still finalizes an interim that never gets a final when both sides are silent', async () => {
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: 'ウェブ版の方です' },
        { at: 0, kind: 'interim', lang: 'en', text: 'Web' },
      ],
      3000,
    );
    expect(adopted(decisions)).toEqual(['ja ウェブ版の方です']);
  });

  // 2026-11-25 11:09:23: en heard "Website system" in the Japanese word ウェブサイト and discarded
  // the whole schedule report as its stuck start. The report must survive.
  it('keeps a Japanese report when en hallucinates "Website system" from ウェブサイト', async () => {
    const report =
      'はいでえっとスケジュールになってますこれまちょっと借り入れなのでま直近12月1日ウェブサイト公開とスポンサー募集開始目標で動いてます';
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: report },
        { at: 500, kind: 'interim', lang: 'en', text: 'Website' },
        { at: 600, kind: 'final', lang: 'en', text: 'Website system' },
        { at: 5600, kind: 'final', lang: 'ja', text: report },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual([`en Website system`, `ja ${report}`]);
  });

  // 2026-11-25 11:29:23: en "Hi hi this is" discarded the ja "はい"; the next utterance repeated
  // it, and the rest (45 seconds of sponsor plans) was dropped as the discarded start's rest.
  it('keeps the rest of a Japanese utterance after a short "はい" was discarded', async () => {
    const rest = 'はい こんな感じです はい じゃ 次 よいしょ';
    const decisions = await run(
      [
        { at: 0, kind: 'interim', lang: 'ja', text: 'はい' },
        { at: 500, kind: 'interim', lang: 'en', text: 'Hi hi this is' },
        { at: 600, kind: 'final', lang: 'en', text: 'Hi hi this is' },
        { at: 5600, kind: 'final', lang: 'ja', text: `はい ${rest}` },
      ],
      8000,
    );
    expect(adopted(decisions)).toEqual([`en Hi hi this is`, `ja ${rest}`]);
  });
});
