import type { Lang } from '../shared/lang';
import { translatorApi, type TranslatorInstance } from '../types/web-ai';
import type { TranslatorBackend } from './backend';

/** Chrome's on-device Translator API: one translator per direction, reused. */
export class ChromeBackend implements TranslatorBackend {
  readonly id = 'chrome';
  readonly #translators = new Map<string, TranslatorInstance>();

  /**
   * Translator.create() needs a user gesture while its model is still downloadable: call this
   * from a click, without awaiting anything before it.
   */
  async prepare(): Promise<void> {
    // 準備 is pressed again after a failed step or a reset: the translators made before are kept.
    if (this.ready) return;
    const pairs = [['ja', 'en'], ['en', 'ja']] as const;
    const created = await Promise.all(
      pairs.map(([s, t]) => translatorApi().create({ sourceLanguage: s, targetLanguage: t })),
    );
    pairs.forEach(([s, t], i) => this.#translators.set(`${s}>${t}`, created[i]!));
  }

  get ready(): boolean {
    return this.#translators.size === 2;
  }

  readonly fast = true;

  async translate(text: string, from: Lang, to: Lang, signal: AbortSignal): Promise<string> {
    const translator = this.#translators.get(`${from}>${to}`);
    if (!translator) throw new Error(`Chrome の翻訳モデル（${from}→${to}）が準備されていません`);
    return translator.translate(text, { signal });
  }

  clearContext(): void {}

  async dispose(): Promise<void> {
    for (const t of this.#translators.values()) t.destroy();
    this.#translators.clear();
  }
}
