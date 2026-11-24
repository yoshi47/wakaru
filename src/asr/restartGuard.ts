export type RestartGuardOptions = {
  /** A session that ends sooner than this after start() counts as abnormal. */
  minSessionMs: number;
  windowMs: number;
  /** More abnormal ends than this within windowMs means the recognizer cannot run. */
  maxAbnormal: number;
};

export const RESTART_GUARD: RestartGuardOptions = { minSessionMs: 1000, windowMs: 10_000, maxAbnormal: 5 };

/**
 * Counts only abnormal restarts. Recognizers end and are restarted all the time (silence,
 * no-speech), so counting every restart would stop a healthy session.
 */
export class RestartGuard {
  readonly #opts: RestartGuardOptions;
  #abnormal: number[] = [];

  constructor(opts: RestartGuardOptions = RESTART_GUARD) {
    this.#opts = opts;
  }

  /** Records a session that ran from startedAt to endedAt. Returns false when it is time to give up. */
  ended(startedAt: number, endedAt: number): boolean {
    if (endedAt - startedAt >= this.#opts.minSessionMs) return true;
    this.#abnormal = this.#abnormal.filter((t) => endedAt - t < this.#opts.windowMs);
    this.#abnormal.push(endedAt);
    return this.#abnormal.length <= this.#opts.maxAbnormal;
  }
}
