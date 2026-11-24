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

export function normalize(lang: Lang, text: string): string {
  return lang === 'ja' ? normalizeJa(text) : text.trim().replace(/\s+/g, ' ');
}
