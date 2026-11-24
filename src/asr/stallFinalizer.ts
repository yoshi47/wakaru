import type { Lang } from '../shared/lang';
import type { Final } from './arbiter';

type State = {
  generation: number;
  text: string;
  changedAt: number;
  /** The interim finalized here, until the recognizer moves on from it. */
  stalled: string | null;
};

const other = (lang: Lang): Lang => (lang === 'ja' ? 'en' : 'ja');

/**
 * What is left of `text` after `prefix`, or null when `text` does not start with it. ja compares
 * without spaces, since finals put spaces between words and interims do not. en compares whole
 * words, so that a stuck "Yo" is not the start of "You know".
 */
function after(lang: Lang, prefix: string, text: string): string | null {
  if (lang === 'en') {
    const p = prefix.trim().split(/\s+/).filter(Boolean);
    const t = text.trim().split(/\s+/).filter(Boolean);
    if (p.some((w, i) => t[i] !== w)) return null;
    return t.slice(p.length).join(' ');
  }
  const p = prefix.replace(/\s/g, '');
  let matched = 0;
  let i = 0;
  for (; i < text.length && matched < p.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    if (ch !== p[matched]) return null;
    matched++;
  }
  return matched === p.length ? text.slice(i).trim() : null;
}

export type StallFinalizerOptions = {
  stallMs: number;
  /** A stalled interim that was dropped as the stuck start of the other language's speech. */
  onDiscard?: (lang: Lang, text: string) => void;
};

/**
 * When speech is followed by silence, Chrome may not send the final until stop(), or ever.
 * Treats an interim that has not changed for stallMs as final. The caller sends the result down
 * the same path as real finals (normalize, then Arbiter). Times come from the caller.
 *
 * Only in silence, and not for the stuck start of the other language's speech. The recognizer
 * of the other language often shows the first word or two of an utterance and then stops
 * updating while the speech goes on (Task 3: "No" from the ja side during "No worries…").
 * Finalizing waits until the other language has been quiet for stallMs too, and an interim that
 * stopped while the other language went on is dropped. The cost: a real short reply that got no
 * final and was talked over is lost too (Task 3.5 measures overlapping speech).
 *
 * Why the recognizer is not restarted after a stall: the restart lands in the pause between
 * utterances, and the new recognizer missed the start of the next one (Task 3: "Sure" and "Most"
 * were lost). Left running, it moves on by itself: the next speech replaces a stuck interim, or
 * a late result repeats the finalized text at its start. That start is cut off, and the rest is
 * handled as a new interim.
 */
export class StallFinalizer {
  readonly #stallMs: number;
  readonly #onDiscard: (lang: Lang, text: string) => void;
  readonly #states = new Map<Lang, State>();
  /** Per language, when it last showed speech (a non-empty interim, or a final). Survives generations. */
  readonly #heardAt = new Map<Lang, number>();

  constructor(opts: StallFinalizerOptions) {
    this.#stallMs = opts.stallMs;
    this.#onDiscard = opts.onDiscard ?? (() => undefined);
  }

  update(lang: Lang, generation: number, interimText: string, now: number): void {
    const s = this.#current(lang, generation);
    if (!s) return;
    this.#setInterim(lang, s, this.#rest(lang, s, interimText), now);
  }

  /**
   * A real final came. Returns false when it repeats the interim already finalized here: its
   * start is cut off and the rest, if any, becomes the interim; the caller drops the final.
   * Otherwise clears the interim so that it is not finalized again.
   */
  onRealFinal(lang: Lang, generation: number, text: string, now: number): boolean {
    const s = this.#current(lang, generation);
    if (!s || !text.trim()) return false;
    const rest = s.stalled === null ? null : after(lang, s.stalled, text);
    // The recognizer has closed this result: what follows is a new one.
    s.stalled = null;
    if (rest !== null) {
      this.#setInterim(lang, s, rest, now);
      return false;
    }
    s.text = '';
    this.#heardAt.set(lang, now);
    return true;
  }

  /**
   * The recognizer of `lang` ended without a final for its interim: finalizes the interim now
   * rather than lose it. While the other language is being heard, or if it was heard after this
   * interim stopped, the interim is discarded instead (the next generation starts empty).
   */
  flush(lang: Lang, generation: number, now: number): Final | null {
    const s = this.#states.get(lang);
    if (!s || s.generation !== generation || !s.text) return null;
    if (this.#otherSpeaking(lang, now) || this.#stuckStart(lang, s)) {
      this.#discard(lang, s);
      return null;
    }
    return this.#finalize(lang, s);
  }

  /** On stop: finalizes every interim left, speech or not. */
  flushAll(): Final[] {
    return [...this.#states].flatMap(([lang, s]) => (s.text ? [this.#finalize(lang, s)] : []));
  }

  tick(now: number): Final[] {
    const out: Final[] = [];
    for (const [lang, s] of this.#states) {
      if (!s.text || now - s.changedAt < this.#stallMs || this.#otherSpeaking(lang, now)) continue;
      if (this.#stuckStart(lang, s)) this.#discard(lang, s);
      else out.push(this.#finalize(lang, s));
    }
    return out;
  }

  /** `text` without the finalized start it repeats; a different start means the recognizer moved on. */
  #rest(lang: Lang, s: State, text: string): string {
    if (s.stalled === null || !text.trim()) return text;
    const rest = after(lang, s.stalled, text);
    if (rest !== null) return rest;
    s.stalled = null;
    return text;
  }

  #setInterim(lang: Lang, s: State, text: string, now: number): void {
    if (text === s.text) return;
    s.text = text;
    s.changedAt = now;
    if (text) this.#heardAt.set(lang, now);
  }

  #otherSpeaking(lang: Lang, now: number): boolean {
    return now - (this.#heardAt.get(other(lang)) ?? -Infinity) < this.#stallMs;
  }

  #stuckStart(lang: Lang, s: State): boolean {
    return s.changedAt < (this.#heardAt.get(other(lang)) ?? -Infinity);
  }

  #discard(lang: Lang, s: State): void {
    this.#onDiscard(lang, s.text);
    s.stalled = s.text;
    s.text = '';
  }

  #finalize(lang: Lang, s: State): Final {
    const final: Final = {
      lang,
      text: s.text,
      // When the speech was last heard, not now: stamped later, it would miss the other
      // recognizer's final in the Arbiter's window, and the latency would count the wait.
      at: s.changedAt,
      synthetic: true,
    };
    s.stalled = s.text;
    s.text = '';
    return final;
  }

  #current(lang: Lang, generation: number): State | null {
    const s = this.#states.get(lang);
    if (s && generation < s.generation) return null;
    if (s && generation === s.generation) return s;
    const fresh: State = { generation, text: '', changedAt: 0, stalled: null };
    this.#states.set(lang, fresh);
    return fresh;
  }
}
