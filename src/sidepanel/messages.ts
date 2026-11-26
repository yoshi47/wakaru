import { MODEL } from '../mt/plamo/modelStore';

/** The model size as the UI shows it, from the pinned file rather than written in two places. */
export const MODEL_MB = Math.round(MODEL.bytes / 1_000_000);

/** The first run: PLaMo's setup is the main action, Chrome is the way past it. */
export const FIRST_RUN_LABEL = 'PLaMo の準備';

/** Everything needed is not here yet, but the model is: 開始 installs the rest and starts. */
export const FIRST_MESSAGE = '「開始」を押すと、足りない言語パックや翻訳モデルをダウンロードしてから聞き取ります';
