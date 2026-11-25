import type { Lang } from '../shared/lang';
import type { Final } from './arbiter';

type State = {
  generation: number;
  text: string;
  changedAt: number;
  /**
   * The interim finalized here, or discarded as the other language's stuck start, until the
   * recognizer moves on from it.
   */
  stalled: { text: string; discarded: boolean } | null;
};

export type DiscardReason = 'stuck start' | 'rest of a stuck start' | 'Latin letters after a stalled start';

const other = (lang: Lang): Lang => (lang === 'ja' ? 'en' : 'ja');
// Katakana counts, unlike in the Arbiter's substantialJa: a Japanese word may follow a pause in
// it ("テスト"). The ja recognizer's katakana spelling of English passes too, as in any final.
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

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
  /** Text dropped as (part of) the other language's speech, and why. */
  onDiscard?: (lang: Lang, text: string, why: DiscardReason) => void;
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
 * a late result repeats the finalized text at its start. That start is cut off: the rest of an
 * interim is handled as the interim, and the rest of a final as the final (see onRealFinal).
 */
export class StallFinalizer {
  readonly #stallMs: number;
  readonly #onDiscard: (lang: Lang, text: string, why: DiscardReason) => void;
  readonly #states = new Map<Lang, State>();
  /**
   * Per language, when it last showed speech: a non-empty interim, or a final that brought words
   * passed on. Survives generations.
   */
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
   * A real final came. Returns what the caller passes on as the final: the final, or, when it
   * repeats the start stalled here, what follows that start. null drops it: empty, a mere repeat,
   * the rest of a start discarded as the other language's, or Latin letters following on the ja
   * side. Clears the interim either way, so that it is not finalized again.
   *
   * What follows goes on at once, not as an interim: the interim that DualRecognizer sends right
   * after a final is '' and would wipe it out, and kept to be finalized later, it would come after
   * the finals that follow it. Latin letters on the ja side are the stuck start of English speech
   * (Task 1: "WEB 版 の 方 です the" while "That makes sense" began). The cost is a Japanese
   * continuation of Latin letters or digits alone ("次は API"): an English word is usually also
   * heard by the en side.
   */
  onRealFinal(lang: Lang, generation: number, text: string, now: number): string | null {
    const s = this.#current(lang, generation);
    if (!s || !text.trim()) return null;
    const stalled = s.stalled;
    const rest = stalled === null ? null : after(lang, stalled.text, text);
    // The recognizer has closed this result: what follows is a new one.
    s.stalled = null;
    s.text = '';
    // Neither a mere repeat nor what is dropped here is new speech of this language: counted as
    // heard, it would hold up the other language's reply, and then drop it as a stuck start.
    if (rest === '') return null;
    if (rest !== null && stalled?.discarded) {
      // The other language's speech, as its start was: "No ウォーリーズ" after a stuck "No".
      this.#onDiscard(lang, rest, 'rest of a stuck start');
      return null;
    }
    if (rest !== null && lang === 'ja' && !JAPANESE.test(rest)) {
      this.#onDiscard(lang, rest, 'Latin letters after a stalled start');
      return null;
    }
    this.#heardAt.set(lang, now);
    return rest ?? text;
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
    const rest = after(lang, s.stalled.text, text);
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
    this.#onDiscard(lang, s.text, 'stuck start');
    s.stalled = { text: s.text, discarded: true };
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
    s.stalled = { text: s.text, discarded: false };
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
