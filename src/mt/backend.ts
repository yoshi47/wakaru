import type { Lang } from '../shared/lang';

export type PrepareProgress = { phase: 'download' | 'load'; ratio?: number };

export interface TranslatorBackend {
  readonly id: 'plamo' | 'chrome';
  /** False before prepare() and after dispose(); for PLaMo also while it reloads after a crash. */
  readonly ready: boolean;
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<void>;
  /** `key`: the paragraph. A paragraph that grows comes again with the same key and more text. */
  translate(text: string, from: Lang, to: Lang, signal: AbortSignal, opts: { key: number }): Promise<string>;
  /**
   * Whether a translation takes well under a second, so that a growing paragraph can be
   * translated again with each piece. False for PLaMo on the CPU. A session reads it once, when it
   * starts: PLaMo reloaded on the CPU after a crash keeps the session's choice until it stops.
   */
  readonly fast: boolean;
  /** From the clear button. */
  clearContext(): void;
  dispose(): Promise<void>;
}
