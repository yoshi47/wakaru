/**
 * The bar for a real Japanese utterance, shared by the Arbiter and the StallFinalizer. Hiragana
 * and kanji only: the ja recognizer may spell English in katakana ("サンキュー"), which would then
 * count as Japanese speech next to the English.
 */
const JA_SUBSTANTIAL = /[\p{Script=Hiragana}\p{Script=Han}]/gu;
const JA_SUBSTANTIAL_CHARS = 4;

export const substantialJa = (text: string) =>
  (text.match(JA_SUBSTANTIAL)?.length ?? 0) >= JA_SUBSTANTIAL_CHARS;
