// Terms the ja recognizer is biased towards (SpeechRecognition.phrases). Chosen from public
// conference-operations glossaries (hyten.jp/yougo/conference), TSKaigi's public team list
// (tskaigi.hatenablog.com/entry/hello-tskaigi-2027), and the 2026-11-25 meeting log. Only the
// words are used, not any definitions. Kept short: a long list dilutes the bias. The user can
// edit them in the settings sheet.
export const DEFAULT_GLOSSARY: readonly string[] = [
  'TSKaigi',
  '稟議',
  '広報',
  '会場',
  '開発',
  '企画',
  '配信',
  'クリエイティブ',
  'スポンサー',
  'サテライト',
  '懇親会',
  'ノベルティ',
  'キーキャップ',
  'タイムテーブル',
  'ブレイクアウトルーム',
  'スタンプラリー',
  'クリアファイル',
  'トートバッグ',
  'エコバッグ',
  'サイドイベント',
  'コアチーム',
  'プログラム',
  'システム',
  'キックオフ',
  'CFP',
  'プロポーザル',
  '基調講演',
  'ブース',
  '経費',
  'ワークフロー',
  'グループメンション',
  'プルリク',
];

export type PhraseHint = { phrase: string; boost: number };

/**
 * The arguments for SpeechRecognitionPhrase: trimmed, non-empty, unique. A fixed boost of 3
 * (about 20x), not 4 or more: a very high one makes the recognizer hear the phrase in other words.
 */
export function phraseHints(terms: readonly string[], boost = 3): PhraseHint[] {
  const seen = new Set<string>();
  const out: PhraseHint[] = [];
  for (const raw of terms) {
    const phrase = raw.trim();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push({ phrase, boost });
  }
  return out;
}
