// Ported from tanakh/plamo-translate-desktop (Apache-2.0 OR MIT), extension/translator.js at
// 3d69a116c45a8116159f1a405311a59039ec4b95.

/**
 * Rough token count for budgets: PLaMo's tokenizer takes about one token per CJK character and
 * about four Latin characters per token.
 */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 0x2e80) narrow++;
    else wide++;
  }
  return Math.ceil(narrow / 4 + wide);
}
