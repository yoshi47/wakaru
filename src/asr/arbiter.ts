import type { Lang } from '../shared/lang';
import { substantialJa } from './japanese';

/** A final result from one recognizer, already normalized. `at` is performance.now(). */
export type Final = { lang: Lang; text: string; at: number; synthetic: boolean };

/**
 * The verdict on one utterance. `lang` is null when neither candidate was valid: the utterance is
 * dropped, and every final is in `rejected`. A window where both languages carry a real utterance
 * (overlapping speech) gives two decisions, ordered by `firstAt`.
 */
export type Decision = {
  lang: Lang | null;
  text: string;
  firstAt: number;
  decidedAt: number;
  rejected: Final[];
};

export type LangDetect = (text: string) => Promise<{ lang: string; confidence: number }>;

export type ArbiterOptions = {
  windowMs: number;
  enMinConfidence: number;
  /** Used instead when ja is empty and en has at most SHORT_WORDS words ("Yeah", "Sure"). */
  enShortMinConfidence: number;
  detect: LangDetect;
  now: () => number;
};

const SHORT_WORDS = 3;

/** `closedAt` is when the window closed: windowMs after firstAt, or when the second language came. */
type Window = { firstAt: number; finals: Final[]; closedAt: number | null };

/**
 * Both recognizers hear every utterance. Groups their finals by time into one window per
 * utterance and decides which language it was, using LanguageDetector for the English side
 * (the English recognizer turns Japanese speech into Spanish- or German-looking text).
 */
export class Arbiter {
  #windows: Window[] = [];
  #last: { lang: Lang; closedAt: number } | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  readonly #opts: ArbiterOptions;

  constructor(opts: ArbiterOptions) {
    this.#opts = opts;
  }

  push(f: Final): void {
    if (!f.text) return;
    let open = this.#windows.at(-1);
    if (open && open.closedAt === null && f.at - open.firstAt >= this.#opts.windowMs) {
      open.closedAt = open.firstAt + this.#opts.windowMs;
    }
    if (!open || open.closedAt !== null) {
      open = { firstAt: f.at, finals: [], closedAt: null };
      this.#windows.push(open);
    }
    open.finals.push(f);
    // A synthetic final carries the time its speech was last heard, which may be earlier than the
    // window's other finals: the window closes at the latest of them.
    if (open.finals.some((g) => g.lang !== f.lang)) open.closedAt = Math.max(...open.finals.map((g) => g.at));
  }

  /** Call every 100ms. */
  flushDue(): Promise<Decision[]> {
    const now = this.#opts.now();
    for (const w of this.#windows) {
      if (w.closedAt === null && now - w.firstAt >= this.#opts.windowMs) {
        w.closedAt = w.firstAt + this.#opts.windowMs;
      }
    }
    return this.#decide(this.#takeWhile((w) => w.closedAt !== null));
  }

  /** Call on stop. */
  flushAll(): Promise<Decision[]> {
    const now = this.#opts.now();
    for (const w of this.#windows) w.closedAt ??= now;
    return this.#decide(this.#takeWhile(() => true));
  }

  #takeWhile(pred: (w: Window) => boolean): Window[] {
    const n = this.#windows.findIndex((w) => !pred(w));
    return this.#windows.splice(0, n === -1 ? this.#windows.length : n);
  }

  // detect() is async: chaining keeps the decisions in the order the windows closed even when
  // calls overlap, which the rule against the opposite language right after a decision relies on.
  #decide(windows: Window[]): Promise<Decision[]> {
    const run = this.#chain.then(async () => {
      const out: Decision[] = [];
      for (const w of windows) out.push(...(await this.#judge(w)));
      return out;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #judge(w: Window): Promise<Decision[]> {
    const last = this.#last;
    // "Okay" and "OK" for the same word: the second one shows up just after the first window.
    // Measured from when that window closed, not from decidedAt: decidedAt includes detect()'s
    // time, and a slow detection would then swallow a real reply in the other language.
    const echo = (f: Final) => !!last && f.lang !== last.lang && f.at - last.closedAt <= this.#opts.windowMs;

    const jaAll = w.finals.filter((f) => f.lang === 'ja');
    const enAll = w.finals.filter((f) => f.lang === 'en');
    const enAllText = joinEn(enAll);
    // Detection decides validity and substance; an all-echo short English side has neither to win.
    const needDetect = enAllText && (enAll.some((f) => !echo(f)) || words(enAllText) > SHORT_WORDS);
    const enAllDetected = needDetect ? await this.#detect(enAllText) : null;
    const jaSub = substantialJa(joinJa(jaAll));
    const enSub = enAllDetected !== null && this.#substantialEn(enAllText, enAllDetected);

    // The echo rule is for short words; a real utterance in the other language is talking over.
    const ja = jaAll.filter((f) => jaSub || !echo(f));
    const en = enAll.filter((f) => enSub || !echo(f));
    const rejected = w.finals.filter((f) => !ja.includes(f) && !en.includes(f));
    const jaText = joinJa(ja);
    const enText = joinEn(en);
    const decidedAt = this.#opts.now();
    const decision = (lang: Lang | null, text: string, firstAt: number, out: Final[]): Decision => ({
      lang,
      text,
      firstAt,
      decidedAt,
      rejected: out,
    });

    if (jaSub && enSub) {
      const both = [
        decision('ja', jaText, ja[0]!.at, []),
        decision('en', enText, en[0]!.at, rejected),
      ].sort((a, b) => a.firstAt - b.firstAt);
      const lastFinal = [...ja, ...en].reduce((a, b) => (b.at > a.at ? b : a));
      this.#last = { lang: lastFinal.lang, closedAt: w.closedAt ?? w.firstAt };
      return both;
    }

    const jaValid = jaText.length > 0;
    const enDetected = !enText ? null : enText === enAllText ? enAllDetected : await this.#detect(enText);
    const enValid = enDetected !== null && this.#isEnglish(enText, enDetected, !jaValid);

    let lang: Lang | null = null;
    if (jaValid && enValid) lang = letters(enText) > letters(jaText) ? 'en' : 'ja';
    else if (jaValid) lang = 'ja';
    else if (enValid) lang = 'en';

    rejected.push(...[...ja, ...en].filter((f) => f.lang !== lang));
    if (lang) this.#last = { lang, closedAt: w.closedAt ?? w.firstAt };
    return [decision(lang, lang === 'ja' ? jaText : lang === 'en' ? enText : '', w.firstAt, rejected)];
  }

  async #detect(text: string): Promise<{ lang: string; confidence: number } | null> {
    try {
      return await this.#opts.detect(text);
    } catch {
      return null;
    }
  }

  #isEnglish(text: string, d: { lang: string; confidence: number }, jaEmpty: boolean): boolean {
    const short = jaEmpty && words(text) <= SHORT_WORDS;
    return d.lang === 'en' && d.confidence >= (short ? this.#opts.enShortMinConfidence : this.#opts.enMinConfidence);
  }

  #substantialEn(text: string, d: { lang: string; confidence: number }): boolean {
    return d.lang === 'en' && d.confidence >= this.#opts.enMinConfidence && words(text) > SHORT_WORDS;
  }
}

const joinJa = (finals: Final[]) => finals.map((f) => f.text).join('');
const joinEn = (finals: Final[]) => finals.map((f) => f.text).join(' ');
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

// What the wrong recognizer produces from the other language is Latin letters on the ja side
// ("OK", "No", "EX") and Spanish- or German-looking text on the en side (Task 1 and 3 logs). A
// real utterance has at least this many hiragana or kanji, or is confidently English and longer
// than a short reply.
// Japanese and English lengths are not really comparable. When both sides are valid but not both
// real utterances, one is a short word or a misrecognition (measured), and the longer side wins;
// Task 6 collects the cases where this is wrong.
const letters = (text: string) => text.replace(/\s/g, '').length;
