import { Arbiter, type Decision, type Final, type LangDetect } from '../asr/arbiter';
import { DualRecognizer } from '../asr/dualRecognizer';
import { normalize } from '../asr/normalize';
import { StallFinalizer } from '../asr/stallFinalizer';
import { startTabAudio, type TabAudio } from '../audio/tabAudio';
import type { TranslatorBackend } from '../mt/backend';
import { TranslationQueue, type Outcome } from '../mt/queue';
import type { Settings } from '../settings';
import type { Lang } from '../shared/lang';

export type SessionEvents = {
  /** The interim line: the longer of the two recognizers' interims, or null when there is none. */
  onInterim(interim: { lang: Lang; text: string } | null): void;
  /** `id` is the translation job's id, or null when the utterance was dropped. */
  onDecision(id: number | null, d: Decision): void;
  onTranslation(o: Outcome): void;
  /** `reason` is null when the user stopped. */
  onEnded(reason: string | null): void;
  onLog(message: string): void;
};

export type SessionOptions = {
  tabId: number;
  settings: Settings;
  detect: LangDetect;
  backend: TranslatorBackend;
  events: SessionEvents;
};

const TICK_MS = 100;
const DRAIN_MS = 5000;
const other = (lang: Lang): Lang => (lang === 'ja' ? 'en' : 'ja');
const letters = (text: string) => text.replace(/\s/g, '').length;

/** One run from start to stop: tab audio → recognizers → StallFinalizer / Arbiter → queue. */
export class Session {
  readonly #events: SessionEvents;
  readonly #arbiter: Arbiter;
  readonly #stall: StallFinalizer;
  readonly #queue: TranslationQueue;
  readonly #interims = new Map<Lang, string>();
  #audio: TabAudio | null = null;
  #recognizer: DualRecognizer | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #nextId = 1;
  #stopping: Promise<void> | null = null;
  #ended = false;

  private constructor(opts: SessionOptions) {
    const { settings, events } = opts;
    this.#events = events;
    this.#arbiter = new Arbiter({
      windowMs: settings.windowMs,
      enMinConfidence: settings.enMinConfidence,
      enShortMinConfidence: settings.enShortMinConfidence,
      detect: opts.detect,
      now: () => performance.now(),
    });
    this.#stall = new StallFinalizer({
      stallMs: settings.stallMs,
      onDiscard: (lang, text) => events.onLog(`${lang} STALL discarded (stuck start): "${text}"`),
    });
    this.#queue = new TranslationQueue({
      translate: (job, signal) => opts.backend.translate(job.text, job.from, job.to, signal),
      // After stop has given up waiting, late results no longer have a place to go.
      onOutcome: (o) => {
        if (!this.#ended) events.onTranslation(o);
      },
      now: () => performance.now(),
    });
  }

  static async start(opts: SessionOptions): Promise<Session> {
    const s = new Session(opts);
    s.#audio = await startTabAudio(opts.tabId, {
      noise: opts.settings.noise,
      onEnded: () => void s.stop('キャプチャ対象のタブが終了しました。アイコンを押し直してください'),
    });
    s.#recognizer = new DualRecognizer(s.#audio.track, {
      onInterim: (lang, generation, text) => s.#onInterim(lang, generation, text),
      onFinal: (lang, generation, text) => s.#onFinal(lang, generation, text),
      onEnd: (lang, generation) => s.#onEnd(lang, generation),
      onFatal: (lang, error) => void s.stop(`音声認識（${lang}）が止まりました: ${error}`),
      onLog: (m) => opts.events.onLog(m),
    });
    try {
      s.#recognizer.start();
    } catch (e) {
      await s.#audio.stop();
      throw e;
    }
    s.#timer = setInterval(() => s.#tick(), TICK_MS);
    opts.events.onLog(`started (noise=${opts.settings.noise}, playback=${s.#audio.playbackState})`);
    return s;
  }

  /** The stop procedure of the plan. Safe to call more than once. */
  stop(reason: string | null = null): Promise<void> {
    this.#stopping ??= (async () => {
      clearInterval(this.#timer);
      this.#recognizer?.stop();
      for (const final of this.#stall.flushAll()) this.#push(final);
      this.#handle(await this.#arbiter.flushAll());
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.#queue.drain(), new Promise((r) => (timeout = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(timeout);
      await this.#audio?.stop();
      this.#ended = true;
      this.#events.onLog(`stopped${reason ? `: ${reason}` : ''}`);
      this.#events.onEnded(reason);
    })();
    return this.#stopping;
  }

  #onInterim(lang: Lang, generation: number, text: string): void {
    this.#stall.update(lang, generation, text, performance.now());
    this.#interims.set(lang, text);
    this.#showInterim();
  }

  #onFinal(lang: Lang, generation: number, text: string): void {
    if (!this.#stall.onRealFinal(lang, generation, text, performance.now())) {
      this.#events.onLog(`${lang} FINAL dropped (repeats a stalled interim, or empty): "${text}"`);
      return;
    }
    this.#push({ lang, text, at: performance.now(), synthetic: false });
  }

  #onEnd(lang: Lang, generation: number): void {
    const stalled = this.#stall.flush(lang, generation, performance.now());
    if (stalled) this.#push(stalled);
    this.#interims.delete(lang);
    this.#showInterim();
  }

  #tick(): void {
    for (const final of this.#stall.tick(performance.now())) this.#push(final);
    void this.#arbiter.flushDue().then((ds) => this.#handle(ds));
  }

  #push(f: Final): void {
    const text = normalize(f.lang, f.text);
    this.#events.onLog(`${f.lang} ${f.synthetic ? 'STALL' : 'FINAL'} "${text}"`);
    this.#arbiter.push({ ...f, text });
  }

  #handle(decisions: Decision[]): void {
    for (const d of decisions) {
      const rejected = d.rejected.map((f) => `${f.lang}:"${f.text}"`).join(' ');
      this.#events.onLog(`decide ${d.lang ?? 'none'} "${d.text}"${rejected ? ` rejected ${rejected}` : ''}`);
      let id: number | null = null;
      if (d.lang) {
        id = this.#nextId++;
        this.#queue.push({ id, text: d.text, from: d.lang, to: other(d.lang), firstAt: d.firstAt });
      }
      this.#events.onDecision(id, d);
    }
    if (decisions.some((d) => d.lang)) {
      this.#interims.clear();
      this.#showInterim();
    }
  }

  #showInterim(): void {
    let best: { lang: Lang; text: string } | null = null;
    for (const [lang, text] of this.#interims) {
      if (text && (!best || letters(text) > letters(best.text))) best = { lang, text };
    }
    this.#events.onInterim(best);
  }
}
