// Types for the vendored wllama (public/vendor/wllama/), as far as wakaru uses it. Why not
// bundling it: the npm release is older than PLaMo 3's tokenizer, so the vendored build is loaded
// from the extension's URL at run time.

type LogFn = (...args: unknown[]) => void;

export type WllamaLogger = { debug: LogFn; log: LogFn; info: LogFn; warn: LogFn; error: LogFn };

export type LoadOptions = {
  n_ctx: number;
  /** 0 keeps everything on the CPU and skips WebGPU. */
  n_gpu_layers: number;
  cache_ram_mib: number;
  n_threads?: number;
};

export type CompletionOptions = {
  prompt: string;
  max_tokens: number;
  temperature: number;
  stop: string[];
  /** Checked before each poll for a result: one step of llama.cpp's loop. */
  abortSignal?: AbortSignal;
};

export type Completion = {
  choices?: { text?: string; finish_reason?: string | null }[];
  timings?: { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number };
};

export interface Wllama {
  loadModel(files: Blob[], options: LoadOptions): Promise<void>;
  createCompletion(options: CompletionOptions): Promise<Completion>;
  getNumThreads(): number;
  /** Ends the worker without settling the calls it runs. */
  exit(): Promise<void>;
}

type WllamaModule = {
  Wllama: new (paths: { default: string }, config: { logger: WllamaLogger }) => Wllama;
};

let module: Promise<WllamaModule> | null = null;

export function importWllama(): Promise<WllamaModule> {
  module ??= (import(/* @vite-ignore */ chrome.runtime.getURL('vendor/wllama/wllama.js')) as Promise<WllamaModule>)
    // A failed import is tried again next time.
    .catch((e: unknown) => {
      module = null;
      throw e;
    });
  return module;
}

export const wllamaWasmUrl = () => chrome.runtime.getURL('vendor/wllama/wllama.wasm');
