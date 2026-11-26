import { MODEL } from '../mt/plamo/modelStore';

/** The model size as the UI shows it, from the pinned file rather than written in two places. */
export const MODEL_MB = Math.round(MODEL.bytes / 1_000_000);

/** Shown in place of 開始 while PLaMo's model is not in OPFS (see isFirstRun). */
export const MODEL_MISSING_MESSAGE =
  `翻訳モデル（${MODEL_MB}MB）のダウンロードが必要です。数分かかります。`;

/** Everything needed is not here yet, but the model is: 開始 installs the rest and starts. */
export const FIRST_MESSAGE = '「開始」を押すと、足りない言語パックや翻訳モデルをダウンロードしてから聞き取ります';

/** The first run, with Chrome's translator available: pick the engine here. */
export const FIRST_RUN_CHOICE_MESSAGE =
  `翻訳エンジンを選べます。PLaMo は訳が自然ですが、初回に ${MODEL_MB}MB のダウンロードが必要です。Chrome 翻訳は軽くて速いです（直訳寄り）。`;
