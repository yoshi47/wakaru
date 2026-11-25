import type { Lang } from '../shared/lang';

/**
 * One version of a paragraph to translate. `key` is the paragraph's: a paragraph that grows is
 * translated again, as a new job. `firstAt` is when the first final of the piece just added came.
 */
export type Job = { id: number; key: number; text: string; from: Lang; to: Lang; firstAt: number };

/** Must stop when `signal` aborts. */
export type Translate = (job: Job, signal: AbortSignal) => Promise<string>;

export type Outcome =
  | { kind: 'done'; job: Job; translation: string; startedAt: number; finishedAt: number }
  | { kind: 'failed'; job: Job; reason: 'timeout' | 'error'; message: string; startedAt: number; finishedAt: number }
  /** Not translated because too many were waiting ("翻訳待ちが多いため省略"). */
  | { kind: 'skipped'; job: Job };

export type QueueOptions = {
  translate: Translate;
  onOutcome: (o: Outcome) => void;
  now: () => number;
  timeoutMs?: number;
  maxPending?: number;
};

class Timeout extends Error {}

/** Translates one job (a version of a paragraph) at a time, in order. */
export class TranslationQueue {
  readonly #translate: Translate;
  readonly #onOutcome: (o: Outcome) => void;
  readonly #now: () => number;
  // The 0.8B model sometimes repeats a word until max_tokens, which would hold up the queue.
  readonly #timeoutMs: number;
  readonly #maxPending: number;
  #waiting: Job[] = [];
  #busy = false;
  #drained: (() => void)[] = [];

  constructor(opts: QueueOptions) {
    this.#translate = opts.translate;
    this.#onOutcome = opts.onOutcome;
    this.#now = opts.now;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#maxPending = opts.maxPending ?? 5;
  }

  get pending(): number {
    return this.#waiting.length;
  }

  /**
   * A waiting job of the same paragraph is replaced in its place, with no outcome: only its
   * latest version is worth translating. The one running is not, and finishes first.
   */
  push(job: Job): void {
    const i = this.#waiting.findIndex((w) => w.key === job.key);
    if (i === -1) this.#waiting.push(job);
    else this.#waiting[i] = job;
    while (this.#waiting.length > this.#maxPending) {
      const skipped = this.#waiting.shift();
      if (skipped) this.#emit({ kind: 'skipped', job: skipped });
    }
    void this.#pump();
  }

  drain(): Promise<void> {
    if (!this.#busy && this.#waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drained.push(resolve));
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    for (let job = this.#waiting.shift(); job; job = this.#waiting.shift()) {
      this.#emit(await this.#run(job));
    }
    this.#busy = false;
    for (const resolve of this.#drained.splice(0)) resolve();
  }

  // A throwing listener must not leave #busy set: the queue would stop and drain() never resolve.
  #emit(o: Outcome): void {
    try {
      this.#onOutcome(o);
    } catch (e) {
      console.error(e);
    }
  }

  async #run(job: Job): Promise<Outcome> {
    const startedAt = this.#now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Racing the timeout keeps the queue moving even if a backend does not honor the signal at once.
    // The next job may then start while the backend is still ending this one: PlamoBackend makes it
    // wait for that itself.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Timeout());
      }, this.#timeoutMs);
    });
    try {
      const translating = this.#translate(job, controller.signal);
      // After a timeout nobody awaits it any more.
      translating.catch(() => undefined);
      const translation = await Promise.race([translating, timeout]);
      return { kind: 'done', job, translation, startedAt, finishedAt: this.#now() };
    } catch (e) {
      const reason = e instanceof Timeout ? 'timeout' : 'error';
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'failed', job, reason, message, startedAt, finishedAt: this.#now() };
    } finally {
      clearTimeout(timer);
    }
  }
}
