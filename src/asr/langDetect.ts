import { languageDetectorApi, type LanguageDetectorInstance } from '../types/web-ai';
import type { LangDetect } from './arbiter';

/** Chrome's LanguageDetector, reduced to its top guess for the Arbiter. */
export class LangDetector {
  readonly #detector: LanguageDetectorInstance;

  private constructor(detector: LanguageDetectorInstance) {
    this.#detector = detector;
  }

  static async create(): Promise<LangDetector> {
    return new LangDetector(await languageDetectorApi().create());
  }

  readonly detect: LangDetect = async (text) => {
    const [top] = await this.#detector.detect(text);
    return top ? { lang: top.detectedLanguage, confidence: top.confidence } : { lang: 'und', confidence: 0 };
  };

  destroy(): void {
    this.#detector.destroy();
  }
}
