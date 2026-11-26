import type { Lang } from '../shared/lang';

// Kana, kanji and full-width punctuation all sit at or above U+2E80 (the same line as estimateTokens).
// Looking at UTF-16 units, a surrogate half also counts as wide: right for CJK Extension B, and
// harmless next to an emoji.
const isWide = (ch: string | undefined) => ch !== undefined && (ch.codePointAt(0) ?? 0) >= 0x2e80;

/**
 * Chrome's Japanese finals put a space between words (`来週 の リリース`). Removes every space with
 * a CJK character on either side, and keeps one space between Latin words (`API rate`).
 */
export function normalizeJa(text: string): string {
  const s = text.trim();
  return s.replace(/\s+/g, (space, i: number) => {
    const before = s[i - 1];
    const after = s[i + space.length];
    return isWide(before) || isWide(after) ? '' : ' ';
  });
}

// The on-device recognizer sometimes leaks its end-of-sentence token into the transcript
// ("E </S>", "Hi </S>"): not speech, and it would be translated as text.
const END_OF_SENTENCE = /<\/S>/g;

/** Strip the token at the source, so that interims and finals are compared without it. */
export const stripEndOfSentence = (text: string): string => text.replace(END_OF_SENTENCE, ' ').trim();

export function normalize(lang: Lang, text: string): string {
  const s = stripEndOfSentence(text);
  return lang === 'ja' ? normalizeJa(s) : s.trim().replace(/\s+/g, ' ');
}
