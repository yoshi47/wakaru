import type { Lang } from '../shared/lang';

export type PrepareProgress = { phase: 'download' | 'load'; ratio?: number };

export interface TranslatorBackend {
  readonly id: 'plamo' | 'chrome';
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<void>;
  translate(text: string, from: Lang, to: Lang, signal: AbortSignal): Promise<string>;
  /** From the clear button. */
  clearContext(): void;
  dispose(): Promise<void>;
}
