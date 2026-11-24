import type { Lang } from '../../shared/lang';

const TAG = '<|plamo:tag|>';
const MSG = '<|plamo:msg|>';
const KEY = '<|plamo:key|>';
const VAL = '<|plamo:val|>';

/** The token that starts the next element: generation stops there. */
export const STOP = TAG;

/** An earlier utterance and its translation, sent as context. */
export type Pair = { text: string; translation: string; from: Lang; to: Lang };

// wllama tokenizes the prompt as one string, special tokens included, so text that looks like one
// gets a zero-width space after `<`.
const escape = (text: string) => text.replaceAll('<|', '<​|');

const input = (lang: Lang, text: string) => `${TAG}input${KEY}lang${VAL}${lang}${MSG}${escape(text)}`;
const output = (lang: Lang) => `${TAG}output${KEY}lang${VAL}${lang}${MSG}`;

/**
 * The PLaMo 3 Translate prompt for `cur` after the `history` pairs. Unlike tanakh's prompt(),
 * which tags every pair with the current languages, each pair keeps its own: in a meeting the
 * direction changes from one utterance to the next.
 */
export function buildPrompt(history: Pair[], cur: { text: string; from: Lang; to: Lang }): string {
  let out = `${TAG}dataset${MSG}translation`;
  for (const p of history) out += input(p.from, p.text) + output(p.to) + escape(p.translation);
  return out + input(cur.from, cur.text) + output(cur.to);
}
