// load(), complete(), isCrash() and crashed() are ported from tanakh/plamo-translate-desktop
// (Apache-2.0 OR MIT), extension/engine.js at 3d69a116c45a8116159f1a405311a59039ec4b95.

import type { Lang } from '../../shared/lang';
import { importWllama, wllamaWasmUrl, type Completion, type CompletionOptions, type Wllama } from '../../types/wllama';
import type { PrepareProgress, TranslatorBackend } from '../backend';
import { estimateTokens } from '../tokens';
import { History } from './history';
import { downloadModel, modelFile } from './modelStore';
import { buildPrompt, STOP } from './prompt';

const N_CTX = 4096;
const MAX_TOKENS = 512;
/** How long an unload waits for a running call to end, in case one never does. */
const SETTLE_MS = 10_000;
const EXIT_MS = 5_000;
const LOAD_MS = 60_000;
/**
 * A call still running this long after its abort is taken for a dead worker. Only a backstop: a
 * worker's errors are caught at the logger (see #load). wllama checks the signal before each poll,
 * and one poll may read a whole prompt, which takes seconds on the CPU: a short bound would take
 * a slow but healthy call for a crash, and reload again and again.
 */
const STUCK_MS = 30_000;

/** A loaded model. `calls` counts the wllama calls running on it (see #complete). */
type Instance = {
  wllama: Wllama;
  /** The GPU llama.cpp computes on, or null on the CPU. */
  gpu: string | null;
  /** Aborts the calls running on it when it is unloaded. */
  controller: AbortController;
  /**
   * Rejects when the instance is unloaded: exit() terminates the worker without settling its
   * calls, which would otherwise stay pending for good.
   */
  gone: Promise<never>;
  kill: (e: Error) => void;
  calls: number;
  waiting: (() => void)[];
  crashed: boolean;
};

function newInstance(wllama: Wllama, gpu: string | null): Instance {
  let kill!: (e: Error) => void;
  const gone = new Promise<never>((_, reject) => (kill = reject));
  gone.catch(() => undefined);
  return { wllama, gpu, controller: new AbortController(), gone, kill, calls: 0, waiting: [], crashed: false };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A WebAssembly abort (out of memory, a lost GPU device, a failed assertion) kills the module. A
 * trap (`memory access out of bounds`) comes as wllama's RuntimeError, named but with the raw
 * message, and leaves the module running on a broken heap.
 */
const isCrash = (e: unknown) =>
  (e instanceof Error && e.name === 'RuntimeError') || /has crashed|\(ABORT\)|unreachable|bad_alloc/.test(message(e));

const cancelled = () => new DOMException('PLaMo の準備は取り消されました', 'AbortError');

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return Boolean(await gpu?.requestAdapter().catch(() => null));
}

/**
 * The GPU llama.cpp computes on, from its messages while loading (its adapter, and the layers
 * offloaded), or null: without an adapter in wllama's worker it quietly computes on the CPU.
 */
function usedGpu(lines: string[]): string | null {
  const adapter = lines.find((l) => l.includes('ggml_webgpu: adapter_info:'));
  const offloaded = lines.map((l) => /offloaded (\d+)\/\d+ layers to GPU/.exec(l)).find(Boolean);
  if (!adapter || !offloaded || offloaded[1] === '0') return null;
  const field = (name: string) => new RegExp(`${name}: ([^|]*)`).exec(adapter)?.[1]?.trim();
  return [field('vendor'), field('architecture')].filter(Boolean).join(' ') || 'WebGPU';
}

const within = (p: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))]).finally(() => clearTimeout(timer));
};

const deadline = <T>(p: Promise<T>, ms: number, why: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(why)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

/** PLaMo 3 Translate 0.8B in this document, with wllama on WebGPU (or the CPU without it). */
export class PlamoBackend implements TranslatorBackend {
  readonly id = 'plamo';
  readonly #onLog: (message: string) => void;
  readonly #history = new History();
  #loaded: Instance | null = null;
  /** Loads and unloads run one at a time, in the order asked for. */
  #loading: Promise<void> = Promise.resolve();
  /** Completions run one at a time: settles when the last one asked for has ended. */
  #turn: Promise<void> = Promise.resolve();
  #download: AbortController | null = null;
  /** Advanced by dispose(), so that a load it overtook does not keep its model. */
  #epoch = 0;
  #reloading = false;

  constructor(opts: { onLog?: (message: string) => void } = {}) {
    this.#onLog = opts.onLog ?? (() => undefined);
  }

  get ready(): boolean {
    return this.#loaded !== null && !this.#loaded.crashed;
  }

  /** What the status shows: `WebGPU (apple metal-3)`, `CPU（遅い）`, or null before loading. */
  get device(): string | null {
    if (!this.#loaded) return null;
    return this.#loaded.gpu ? `WebGPU (${this.#loaded.gpu})` : 'CPU（遅い）';
  }

  /** Downloads the model unless OPFS has it, then loads it. Needs no user gesture. */
  async prepare(onProgress?: (p: PrepareProgress) => void): Promise<void> {
    const epoch = this.#epoch;
    let file = await modelFile();
    if (epoch !== this.#epoch) throw cancelled();
    if (!file) {
      const controller = new AbortController();
      this.#download = controller;
      onProgress?.({ phase: 'download', ratio: 0 });
      const start = performance.now();
      try {
        file = await downloadModel({
          signal: controller.signal,
          onProgress: (ratio) => onProgress?.({ phase: 'download', ratio }),
        });
      } finally {
        if (this.#download === controller) this.#download = null;
      }
      this.#onLog(`plamo downloaded in ${Math.round((performance.now() - start) / 1000)}s`);
      if (epoch !== this.#epoch) throw cancelled();
    }
    onProgress?.({ phase: 'load' });
    const model = file;
    await this.#enqueue(() => this.#load(model, epoch));
  }

  async translate(text: string, from: Lang, to: Lang, signal: AbortSignal): Promise<string> {
    // Fails at once while reloading after a crash: the queue shows the source alone meanwhile.
    if (!this.ready) throw new Error(this.#reloading ? 'PLaMo を読み込み直しています' : 'PLaMo が準備されていません');
    // The queue gives up on a job after its timeout and starts the next one, while wllama ends the
    // aborted call only at its next poll: the next waits for that, with one call at a time.
    const previous = this.#turn;
    let release!: () => void;
    this.#turn = new Promise((resolve) => (release = resolve));
    try {
      await previous;
      signal.throwIfAborted();
      const instance = this.#loaded;
      if (!instance || instance.crashed) throw new Error('PLaMo を読み込み直しています');
      const result = await this.#complete(instance, {
        prompt: buildPrompt(this.#history.pairs, { text, from, to }),
        max_tokens: Math.min(MAX_TOKENS, estimateTokens(text) * 3 + 64),
        temperature: 0,
        stop: [STOP],
        abortSignal: AbortSignal.any([signal, instance.controller.signal]),
      });
      // Ended by the abort after all: the queue has given up on it, and it stays out of the history.
      signal.throwIfAborted();
      const choice = result.choices?.[0];
      const translation = (choice?.text ?? '').trim();
      if (choice?.finish_reason === 'length') {
        // Usually a word repeated until max_tokens: shown, but kept out of the next prompts.
        this.#onLog(`plamo cut at max_tokens: "${text}"`);
      } else {
        this.#history.add({ text, translation, from, to });
      }
      return translation;
    } finally {
      release();
    }
  }

  clearContext(): void {
    this.#history.clear();
  }

  async dispose(): Promise<void> {
    this.#epoch++;
    this.#download?.abort();
    this.#history.clear();
    await this.#enqueue(() => this.#unload());
  }

  /** Runs `step` after the loads and unloads asked for before it. */
  #enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.#loading.then(step);
    this.#loading = next.catch(() => undefined);
    return next;
  }

  /** Loads `file` (in the load chain) unless a model is loaded, trying WebGPU first. */
  async #load(file: File, epoch: number): Promise<void> {
    if (this.#loaded && !this.#loaded.crashed) return;
    await this.#unload();
    const { Wllama } = await importWllama();
    const devices = (await hasWebGpu()) ? ['gpu', 'cpu'] : ['cpu'];
    let failure: unknown;
    for (const device of devices) {
      if (epoch !== this.#epoch) throw cancelled();
      // llama.cpp's messages while loading tell which device it really uses. Kept while loading
      // only: it logs every request afterwards.
      const lines: string[] = [];
      let collecting = true;
      const keep = (...args: unknown[]) => {
        if (collecting) lines.push(args.join(' '));
      };
      let instance: Instance | null = null;
      // wllama hands a worker's errors (`worker.onerror`) to the logger and nothing else, leaving
      // its calls unsettled: they are taken for a crash here.
      const error = (...args: unknown[]) => {
        keep(...args);
        console.error(...args);
        const [event] = args;
        if (event instanceof ErrorEvent && instance) {
          this.#crashed(instance, new Error(`wllama の worker でエラー: ${event.message}`));
        }
      };
      const wllama = new Wllama(
        { default: wllamaWasmUrl() },
        { logger: { debug: keep, log: keep, info: keep, warn: keep, error } },
      );
      const start = performance.now();
      try {
        // A load that never ends (a dead worker) would hold up the load chain, and dispose() with it.
        await deadline(
          wllama.loadModel([file], {
            n_ctx: N_CTX,
            n_gpu_layers: device === 'gpu' ? 999 : 0,
            // No prompt cache: it would copy the KV state into WebAssembly memory, up to 8 GiB by
            // default, past the 4 GiB there is.
            cache_ram_mib: 0,
          }),
          LOAD_MS,
          `読み込みが ${LOAD_MS / 1000} 秒で終わりませんでした`,
        );
      } catch (e) {
        collecting = false;
        await within(wllama.exit().catch(() => undefined), EXIT_MS);
        this.#onLog(`plamo load on ${device} failed: ${message(e)}`);
        failure = e;
        continue;
      }
      collecting = false;
      if (epoch !== this.#epoch) {
        await within(wllama.exit().catch(() => undefined), EXIT_MS);
        throw cancelled();
      }
      const gpu = device === 'gpu' ? usedGpu(lines) : null;
      instance = newInstance(wllama, gpu);
      this.#loaded = instance;
      this.#onLog(
        `plamo loaded in ${Math.round(performance.now() - start)}ms on ${this.device}, threads=${wllama.getNumThreads()}`,
      );
      if (device === 'gpu' && !gpu) {
        this.#onLog(`plamo: WebGPU was not used: ${lines.filter((l) => /webgpu|offload/i.test(l)).join(' / ')}`);
      }
      return;
    }
    throw failure;
  }

  /**
   * Unloads the model (in the load chain). wllama's exit() ends its worker without settling the
   * calls it runs, so they are aborted and awaited first, and the ones left are rejected.
   */
  async #unload(): Promise<void> {
    const current = this.#loaded;
    if (!current) return;
    this.#loaded = null;
    current.controller.abort();
    // A crashed worker may never answer: no use waiting for its calls.
    if (current.calls > 0 && !current.crashed) {
      await within(new Promise<void>((r) => current.waiting.push(r)), SETTLE_MS);
    }
    await within(current.wllama.exit().catch(() => undefined), EXIT_MS);
    current.kill(new Error('PLaMo を読み込み直しています'));
  }

  /** Runs a completion, counted so that unloading waits for it, and reloading after a crash. */
  async #complete(instance: Instance, options: CompletionOptions): Promise<Completion> {
    instance.calls++;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      watchdog = setTimeout(() => this.#crashed(instance, new Error(`wllama は中断の ${STUCK_MS}ms 後も止まりませんでした`)), STUCK_MS);
    };
    const signal = options.abortSignal;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([instance.wllama.createCompletion(options), instance.gone]);
    } catch (e) {
      if (isCrash(e)) this.#crashed(instance, e);
      throw e;
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      if (--instance.calls === 0) for (const resolve of instance.waiting.splice(0)) resolve();
    }
  }

  /** After wllama crashed, the model is unloaded and loaded again from OPFS. */
  #crashed(instance: Instance, e: unknown): void {
    // An instance being unloaded (dispose(), or a reload already under way) is not loaded again.
    if (instance.crashed || this.#loaded !== instance) return;
    instance.crashed = true;
    this.#reloading = true;
    this.#onLog(`plamo crashed: ${message(e)}; reloading`);
    const epoch = this.#epoch;
    void this.#enqueue(async () => {
      if (this.#loaded === instance) await this.#unload();
      const file = await modelFile();
      if (!file) throw new Error('OPFS にモデルがありません');
      await this.#load(file, epoch);
    })
      .then(
        () => this.#onLog('plamo reloaded'),
        (err: unknown) => this.#onLog(`plamo reload failed: ${message(err)}`),
      )
      .finally(() => {
        this.#reloading = false;
      });
  }
}
