import type { Lang } from '../shared/lang';

/** A final result from one recognizer, already normalized. `at` is performance.now(). */
export type Final = { lang: Lang; text: string; at: number; synthetic: boolean };

/**
 * The verdict on one utterance. `lang` is null when neither candidate was valid: the utterance is
 * dropped, and every final is in `rejected`.
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
    if (open.finals.some((g) => g.lang !== f.lang)) open.closedAt = f.at;
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
      for (const w of windows) out.push(await this.#judge(w));
      return out;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #judge(w: Window): Promise<Decision> {
    const rejected: Final[] = [];
    const kept: Final[] = [];
    const last = this.#last;
    for (const f of w.finals) {
      // "Okay" and "OK" for the same word: the second one shows up just after the first window.
      // Measured from when that window closed, not from decidedAt: decidedAt includes detect()'s
      // time, and a slow detection would then swallow a real reply in the other language.
      const echo = last && f.lang !== last.lang && f.at - last.closedAt <= this.#opts.windowMs;
      (echo ? rejected : kept).push(f);
    }
    const ja = kept.filter((f) => f.lang === 'ja');
    const en = kept.filter((f) => f.lang === 'en');
    const jaText = ja.map((f) => f.text).join('');
    const enText = en.map((f) => f.text).join(' ');

    const jaValid = jaText.length > 0;
    const enValid = enText.length > 0 && (await this.#isEnglish(enText, jaText.length === 0));

    let lang: Lang | null = null;
    if (jaValid && enValid) lang = letters(enText) > letters(jaText) ? 'en' : 'ja';
    else if (jaValid) lang = 'ja';
    else if (enValid) lang = 'en';

    rejected.push(...kept.filter((f) => f.lang !== lang));
    const decision: Decision = {
      lang,
      text: lang === 'ja' ? jaText : lang === 'en' ? enText : '',
      firstAt: w.firstAt,
      decidedAt: this.#opts.now(),
      rejected,
    };
    if (lang) this.#last = { lang, closedAt: w.closedAt ?? w.firstAt };
    return decision;
  }

  async #isEnglish(text: string, jaEmpty: boolean): Promise<boolean> {
    const short = jaEmpty && text.split(/\s+/).length <= SHORT_WORDS;
    const min = short ? this.#opts.enShortMinConfidence : this.#opts.enMinConfidence;
    try {
      const r = await this.#opts.detect(text);
      return r.lang === 'en' && r.confidence >= min;
    } catch {
      return false;
    }
  }
}

// Japanese and English lengths are not really comparable. Both sides are valid only for short
// words and English misrecognitions (measured), and the longer side wins those; Task 6 collects
// the cases where this is wrong.
const letters = (text: string) => text.replace(/\s/g, '').length;
