import type { Lang } from '../shared/lang';
import type { Final } from './arbiter';

/** A synthetic final, and the recognizer generation that produced it (the one to restart). */
export type Stalled = { final: Final; generation: number };

type State = { generation: number; text: string; changedAt: number; finalized: boolean };

/**
 * When speech is followed by silence, Chrome may not send the final until stop(), or ever.
 * Treats an interim that has not changed for stallMs as final. The caller sends the result down
 * the same path as real finals (normalize, then Arbiter) and restarts that recognizer, whose
 * next generation starts clean. Times come from the caller.
 */
export class StallFinalizer {
  readonly #stallMs: number;
  readonly #states = new Map<Lang, State>();

  constructor(opts: { stallMs: number }) {
    this.#stallMs = opts.stallMs;
  }

  update(lang: Lang, generation: number, interimText: string, now: number): void {
    const s = this.#current(lang, generation);
    if (!s || s.finalized) return;
    if (interimText !== s.text) {
      s.text = interimText;
      s.changedAt = now;
    }
  }

  /**
   * A real final came. Clears the interim so that it is not finalized again later. Returns false
   * when this generation was already finalized here: the caller drops that final as a duplicate.
   */
  onRealFinal(lang: Lang, generation: number): boolean {
    const s = this.#current(lang, generation);
    if (!s || s.finalized) return false;
    s.text = '';
    return true;
  }

  tick(now: number): Stalled[] {
    const out: Stalled[] = [];
    for (const [lang, s] of this.#states) {
      if (s.finalized || !s.text || now - s.changedAt < this.#stallMs) continue;
      s.finalized = true;
      // `at` is when the speech was last heard, not now: stamped stallMs later, it would miss the
      // other recognizer's final in the Arbiter's window, and the latency would count the wait.
      out.push({ final: { lang, text: s.text, at: s.changedAt, synthetic: true }, generation: s.generation });
    }
    return out;
  }

  #current(lang: Lang, generation: number): State | null {
    const s = this.#states.get(lang);
    if (s && generation < s.generation) return null;
    if (s && generation === s.generation) return s;
    const fresh: State = { generation, text: '', changedAt: 0, finalized: false };
    this.#states.set(lang, fresh);
    return fresh;
  }
}
