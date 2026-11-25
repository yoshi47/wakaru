import { estimateTokens } from '../mt/tokens';
import type { Lang } from '../shared/lang';

/** One decided utterance. `firstAt` is the Decision's: when its first final came. */
export type Piece = { lang: Lang; text: string; firstAt: number };

/** One subtitle: the pieces added to it so far. `key` is unique within a session, from 1. */
export type Paragraph = { key: number; lang: Lang; text: string; pieces: readonly Piece[] };

/** Why the paragraph open before was closed. */
export type CloseReason = 'gap' | 'limit' | 'lang';

export type ParagraphUpdate = {
  kind: 'new' | 'append';
  /** A copy: later pieces do not change it. */
  paragraph: Paragraph;
  /** When this piece started a new paragraph after another one was open. */
  closed: CloseReason | null;
};

export type ParagrapherOptions = {
  /** The silence that closes a paragraph just started. */
  maxGapMs: number;
  /** The silence that closes a paragraph at maxTokens. In between, it shrinks with the length. */
  minGapMs: number;
  /** A paragraph is not extended past this many estimated tokens. */
  maxTokens: number;
  /** false: every piece is a paragraph of its own. */
  merge: boolean;
  /** Every silence of at least minGapMs, when speech resumes after it. */
  onSilence?: (silenceMs: number) => void;
};

type Open = { key: number; lang: Lang; pieces: Piece[]; tokens: number };

const SHORT_WORDS = 3;
const SHORT_JA_CHARS = 8;
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
// Katakana is left out as in the Arbiter's substantialJa: the ja recognizer may spell English in it.
const jaChars = (text: string) => text.match(/[\p{Script=Hiragana}\p{Script=Han}]/gu)?.length ?? 0;

/**
 * A reply too short to end the other language's paragraph: "OK", "はい", "うんうん", "そうですね",
 * "Okay". Without this, a backchannel, or an English "Okay" that the Arbiter took as the
 * Japanese side's "OK", would cut an English monologue in three. Not the Arbiter's bar for a real
 * utterance (4 characters): "うんうん" and "そうですね" pass it.
 */
export const isShortReply = (lang: Lang, text: string) =>
  lang === 'ja' ? jaChars(text) < SHORT_JA_CHARS : words(text) <= SHORT_WORDS;

const join = (lang: Lang, pieces: readonly Piece[]) => pieces.map((p) => p.text).join(lang === 'ja' ? '' : ' ');

/**
 * Puts the decided utterances together into paragraphs: one speaker's talk comes in pieces (the
 * recognizer's finals stop mid-sentence, and so does a stalled interim), each of which alone
 * translates into nonsense. A piece is added to the open paragraph unless the language changed,
 * there was silence between them, or the paragraph would get too long.
 *
 * Silence is measured on the interims, which keep changing while anyone speaks: decisions come
 * after windowMs or stallMs, so their spacing says little (2.5s apart in one breath was seen).
 * Speakers are not told apart: one who starts right after another joins their paragraph. Each
 * sentence of it still reads, whereas a sentence cut in pieces does not.
 */
export class Paragrapher {
  readonly #opts: ParagrapherOptions;
  #lastHeard = -Infinity;
  /** Silences of at least minGapMs, by when speech resumed after them. */
  #silences: { at: number; ms: number }[] = [];
  #open: Open | null = null;
  #nextKey = 1;

  constructor(opts: ParagrapherOptions) {
    this.#opts = opts;
  }

  /** A non-empty interim changed, in either language. */
  heard(now: number): void {
    const ms = now - this.#lastHeard;
    this.#lastHeard = now;
    if (!Number.isFinite(ms) || ms < this.#opts.minGapMs) return;
    this.#opts.onSilence?.(ms);
    // Without merging nothing prunes them, and they would pile up for the whole meeting.
    if (this.#opts.merge) this.#silences.push({ at: now, ms });
  }

  add(piece: Piece): ParagraphUpdate {
    const open = this.#open;
    if (!this.#opts.merge || !open) return this.#start(piece, null);
    if (open.lang !== piece.lang) {
      // Its own subtitle, while the open paragraph stays open.
      if (isShortReply(piece.lang, piece.text)) return { kind: 'new', paragraph: this.#copy(this.#single(piece)), closed: null };
      return this.#start(piece, 'lang');
    }
    if (this.#silenceBefore(open, piece)) return this.#start(piece, 'gap');
    const tokens = estimateTokens(piece.text);
    if (open.tokens + tokens > this.#opts.maxTokens) return this.#start(piece, 'limit');
    open.pieces.push(piece);
    open.tokens += tokens;
    this.#prune(open);
    return { kind: 'append', paragraph: this.#copy(open), closed: null };
  }

  /** The clear button: the next piece starts a new paragraph. */
  close(): void {
    this.#open = null;
  }

  /**
   * The silence that closes `open` now: maxGapMs up to half of maxTokens, then shorter as it gets
   * longer. Why not from the start: a pause of 1.8s, measured as 2.0 to 2.1s, split a 38-token
   * paragraph one time in four, and its last piece translated alone into a fragment.
   */
  #gapMs(open: Open): number {
    const { maxGapMs, minGapMs, maxTokens } = this.#opts;
    const half = maxTokens / 2;
    return maxGapMs - (maxGapMs - minGapMs) * Math.min(1, Math.max(0, open.tokens - half) / half);
  }

  /**
   * Whether speech resumed after a long enough silence between the paragraph's last piece and
   * `piece`. Both firstAt come after the speech of their piece (a stalled interim's last change,
   * or a final's arrival), so a silence ending in between came before `piece`'s speech.
   */
  #silenceBefore(open: Open, piece: Piece): boolean {
    const last = open.pieces.at(-1)!.firstAt;
    const gap = this.#gapMs(open);
    return this.#silences.some((s) => s.at > last && s.at <= piece.firstAt && s.ms >= gap);
  }

  #start(piece: Piece, closed: CloseReason | null): ParagraphUpdate {
    const open = this.#single(piece);
    if (this.#opts.merge) {
      this.#open = open;
      this.#prune(open);
    }
    return { kind: 'new', paragraph: this.#copy(open), closed };
  }

  #single(piece: Piece): Open {
    return { key: this.#nextKey++, lang: piece.lang, pieces: [piece], tokens: estimateTokens(piece.text) };
  }

  /** Silences before the paragraph's last piece no longer matter. */
  #prune(open: Open): void {
    const last = open.pieces.at(-1)!.firstAt;
    this.#silences = this.#silences.filter((s) => s.at > last);
  }

  #copy(open: Open): Paragraph {
    return { key: open.key, lang: open.lang, text: join(open.lang, open.pieces), pieces: [...open.pieces] };
  }
}
