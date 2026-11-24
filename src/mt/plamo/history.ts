// Ported from tanakh/plamo-translate-desktop (Apache-2.0 OR MIT), extension/translator.js at
// 3d69a116c45a8116159f1a405311a59039ec4b95.

import { estimateTokens } from '../tokens';
import type { Pair } from './prompt';

/** Token budget for the earlier pairs sent with each request. */
export const HISTORY_TOKENS = 768;

/**
 * The earlier pairs sent with each request, within `maxTokens`. Pairs are only added at the end
 * and dropped from the start several at a time, so that consecutive prompts mostly begin the
 * same way and llama.cpp can reuse its work on the common beginning. Add only pairs that were
 * translated: skipped and failed utterances stay out.
 */
export class History {
  readonly #maxTokens: number;
  #entries: { pair: Pair; cost: number }[] = [];
  #tokens = 0;

  constructor(maxTokens: number = HISTORY_TOKENS) {
    this.#maxTokens = maxTokens;
  }

  get pairs(): Pair[] {
    return this.#entries.map((e) => e.pair);
  }

  add(pair: Pair): void {
    const cost = estimateTokens(pair.text) + estimateTokens(pair.translation) + 16;
    if (cost > this.#maxTokens) {
      this.clear();
      return;
    }
    this.#entries.push({ pair, cost });
    this.#tokens += cost;
    if (this.#tokens > this.#maxTokens) {
      // Down to half the budget at once, rather than one pair per request.
      while (this.#tokens > this.#maxTokens / 2) this.#tokens -= this.#entries.shift()?.cost ?? 0;
    }
  }

  clear(): void {
    this.#entries = [];
    this.#tokens = 0;
  }
}
