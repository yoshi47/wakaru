import type { Lang } from '../shared/lang';
import { translatorApi, type TranslatorInstance } from '../types/web-ai';
import type { Direction, PrepareProgress, TranslatorBackend } from './backend';

const BOTH: readonly Direction[] = [
  ['ja', 'en'],
  ['en', 'ja'],
];

/** Chrome's on-device Translator API: one translator per direction, reused. */
export class ChromeBackend implements TranslatorBackend {
  readonly id = 'chrome';
  readonly #translators = new Map<string, TranslatorInstance>();
  /** What the current session needs; `ready` is about these, not about both directions. */
  #directions: readonly Direction[] = BOTH;

  /**
   * Translator.create() needs a user gesture while its model is still downloadable: call this
   * from a click, without awaiting anything before it.
   */
  async prepare(
    _onProgress?: (p: PrepareProgress) => void,
    directions: readonly Direction[] = BOTH,
  ): Promise<void> {
    this.#directions = directions;
    // 準備 is pressed again after a failed step, a reset, or a language change: only make the
    // directions not made yet. A direction no longer used stays loaded until dispose().
    const missing = directions.filter(([s, t]) => !this.#translators.has(`${s}>${t}`));
    if (!missing.length) return;
    const created = await Promise.all(
      missing.map(([s, t]) => translatorApi().create({ sourceLanguage: s, targetLanguage: t })),
    );
    missing.forEach(([s, t], i) => this.#translators.set(`${s}>${t}`, created[i]!));
  }

  get ready(): boolean {
    return this.#directions.every(([s, t]) => this.#translators.has(`${s}>${t}`));
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
