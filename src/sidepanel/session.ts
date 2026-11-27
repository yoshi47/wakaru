import { Arbiter, type Decision, type Final, type LangDetect } from '../asr/arbiter';
import { DualRecognizer } from '../asr/dualRecognizer';
import { normalize } from '../asr/normalize';
import { Paragrapher, type ParagraphUpdate } from '../asr/paragrapher';
import { StallFinalizer } from '../asr/stallFinalizer';
import type { TabAudio, TabAudioOptions } from '../audio/tabAudio';
import type { TranslatorBackend } from '../mt/backend';
import { TranslationQueue, type Outcome } from '../mt/queue';
import type { Settings, LangMode } from '../settings';
import type { Lang } from '../shared/lang';

export type SessionEvents = {
  /** The interim line: the longer of the two recognizers' interims, or null when there is none. */
  onInterim(interim: { lang: Lang; text: string } | null): void;
  /** A paragraph started or grew; `jobId` is the job translating this version of it. */
  onParagraph(jobId: number, u: ParagraphUpdate): void;
  onTranslation(o: Outcome): void;
  /**
   * `reason` is null when the user stopped. `fatal`: a recognizer stopped for good, which the
   * panel shows as an error; otherwise the captured tab ended.
   */
  onEnded(reason: string | null, fatal: boolean): void;
  /** The microphone ended by itself (the device was removed); the tab audio keeps going. */
  onMicEnded?(): void;
  onLog(message: string): void;
};

export type SessionOptions = {
  /** Starts the audio to recognize: the target tab's (startTabAudio), or files (src/dev/harness.ts). */
  audio: (opts: TabAudioOptions) => Promise<TabAudio>;
  settings: Settings;
  detect: LangDetect;
  backend: TranslatorBackend;
  events: SessionEvents;
};

const TICK_MS = 100;
const DRAIN_MS = 5000;
const other = (lang: Lang): Lang => (lang === 'ja' ? 'en' : 'ja');
const letters = (text: string) => text.replace(/\s/g, '').length;
/**
 * Speech in the debug log. Quotes inside it become fullwidth, so the log's redaction can take the
 * whole `"..."` span: the log is copyable and the microphone puts private speech in it.
 */
const quote = (text: string): string => `"${text.replaceAll('"', '＂')}"`;
/** Which recognizers run for each mode. `auto` is the old behavior (both). */
const LANGS: Record<LangMode, readonly Lang[]> = { auto: ['ja', 'en'], ja: ['ja'], en: ['en'] };

/** One run from start to stop: tab audio → recognizers → StallFinalizer / Arbiter → queue. */
export class Session {
  readonly #events: SessionEvents;
  readonly #arbiter: Arbiter;
  readonly #stall: StallFinalizer;
  readonly #queue: TranslationQueue;
  readonly #paragrapher: Paragrapher;
  /** Whether pieces are put together into paragraphs: decided once, when the session starts. */
  readonly #merge: boolean;
  readonly #interims = new Map<Lang, string>();
  /**
   * The last non-empty interim per language, to tell speech (an interim that changes) for the
   * Paragrapher. Apart from #interims, which every decision clears: the same interim sent again
   * after it would count as speech.
   */
  readonly #heard = new Map<Lang, { generation: number; text: string }>();
  #audio: TabAudio | null = null;
  #recognizer: DualRecognizer | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #nextId = 1;
  #stopping: Promise<void> | null = null;
  #ended = false;
  /** クリア: a decision for speech before this is dropped, so that cleared text cannot come back. */
  #clearedAt = -Infinity;

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
      onDiscard: (lang, text, why) => events.onLog(`${lang} discarded (${why}): ${quote(text)}`),
    });
    this.#merge = opts.backend.fast;
    this.#paragrapher = new Paragrapher({
      maxGapMs: settings.paragraphMaxGapMs,
      minGapMs: settings.paragraphMinGapMs,
      maxTokens: settings.paragraphMaxTokens,
      merge: this.#merge,
      onSilence: (ms) => events.onLog(`silence ${Math.round(ms)}ms`),
    });
    this.#queue = new TranslationQueue({
      translate: (job, signal) => opts.backend.translate(job.text, job.from, job.to, signal, { key: job.key }),
      // After stop has given up waiting, late results no longer have a place to go.
      onOutcome: (o) => {
        if (!this.#ended) events.onTranslation(o);
      },
      now: () => performance.now(),
    });
  }

  static async start(opts: SessionOptions): Promise<Session> {
    const s = new Session(opts);
    s.#audio = await opts.audio({
      noise: opts.settings.noise,
      mic: opts.settings.mic,
      onMicEnded: () => {
        opts.events.onLog('microphone ended: continuing with the tab audio');
        opts.events.onMicEnded?.();
      },
      onEnded: () => void s.stop('キャプチャ対象のタブが終了しました。アイコンを押し直してください'),
    });
    const langs = LANGS[opts.settings.langMode];
    s.#recognizer = new DualRecognizer(
      s.#audio.track,
      {
        onInterim: (lang, generation, text) => s.#onInterim(lang, generation, text),
        onFinal: (lang, generation, text) => s.#onFinal(lang, generation, text),
        onEnd: (lang, generation) => s.#onEnd(lang, generation),
        onFatal: (lang, error) => void s.stop(`音声認識（${lang}）が止まりました: ${error}`, true),
        onLog: (m) => opts.events.onLog(m),
      },
      { langs, glossary: opts.settings.glossary },
    );
    try {
      s.#recognizer.start();
    } catch (e) {
      await s.#audio.stop();
      throw e;
    }
    s.#timer = setInterval(() => s.#tick(), TICK_MS);
    opts.events.onLog(
      `started (noise=${opts.settings.noise}, mic=${s.#audio.mic}${s.#audio.micError ? ` (${s.#audio.micError})` : ''}, playback=${s.#audio.playbackState}, paragraphs=${s.#merge ? 'on' : 'off'}, langs=${langs.join(',')}, glossary=${opts.settings.glossary.length})`,
    );
    return s;
  }

  /** Whether the microphone is mixed into this run. False when it was asked for but could not start. */
  get mic(): boolean {
    return this.#audio?.mic ?? false;
  }

  /** Why the microphone is not mixed, when it was asked for. */
  get micError(): string | undefined {
    return this.#audio?.micError;
  }

  /** The stop procedure of the plan. Safe to call more than once. */
  stop(reason: string | null = null, fatal = false): Promise<void> {
    this.#stopping ??= (async () => {
      try {
        clearInterval(this.#timer);
        try {
          this.#recognizer?.stop();
        } finally {
          // Stop the capture before the drain: the microphone should not stay live while the last
          // translations finish. A failed close must not leave the panel in 停止中.
          await this.#audio?.stop().catch((e: unknown) => {
            this.#events.onLog(`audio stop failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
        for (const final of this.#stall.flushAll()) this.#push(final);
        this.#handle(await this.#arbiter.flushAll());
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.#queue.drain(), new Promise((r) => (timeout = setTimeout(r, DRAIN_MS)))]);
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        this.#ended = true;
        this.#events.onLog(`stopped${reason ? `: ${reason}` : ''}`);
        this.#events.onEnded(reason, fatal);
      }
    })();
    return this.#stopping;
  }

  /** The clear button: speech already captured is dropped; what comes next starts a new paragraph. */
  closeParagraph(): void {
    this.#clearedAt = performance.now();
    this.#paragrapher.close();
  }

  #onInterim(lang: Lang, generation: number, text: string): void {
    const now = performance.now();
    this.#stall.update(lang, generation, text, now);
    this.#interims.set(lang, text);
    // DualRecognizer sends '' after every final: not speech, nor a change to remember.
    const last = this.#heard.get(lang);
    if (text.trim() && (last?.generation !== generation || last.text !== text)) {
      this.#heard.set(lang, { generation, text });
      this.#paragrapher.heard(now);
    }
    this.#showInterim();
  }

  #onFinal(lang: Lang, generation: number, text: string): void {
    // A result closed: the same words again (「はい」 after silence) are new speech.
    this.#heard.delete(lang);
    const passed = this.#stall.onRealFinal(lang, generation, text, performance.now());
    if (passed === null) {
      this.#events.onLog(`${lang} FINAL dropped (empty, a repeat of a stalled interim, or its rest discarded): ${quote(text)}`);
      return;
    }
    if (passed !== text) this.#events.onLog(`${lang} FINAL cut to what follows a stalled interim: ${quote(text)}`);
    this.#push({ lang, text: passed, at: performance.now(), synthetic: false });
  }

  #onEnd(lang: Lang, generation: number): void {
    const stalled = this.#stall.flush(lang, generation, performance.now());
    if (stalled) this.#push(stalled);
    this.#heard.delete(lang);
    this.#interims.delete(lang);
    this.#showInterim();
  }

  #tick(): void {
    for (const final of this.#stall.tick(performance.now())) this.#push(final);
    void this.#arbiter.flushDue().then((ds) => this.#handle(ds));
  }

  #push(f: Final): void {
    const text = normalize(f.lang, f.text);
    if (!text) return;
    this.#events.onLog(`${f.lang} ${f.synthetic ? 'STALL' : 'FINAL'} ${quote(text)}`);
    this.#arbiter.push({ ...f, text });
  }

  #handle(decisions: Decision[]): void {
    for (const d of decisions) {
      // detect() may still be running when クリア comes: the window was heard before it.
      if (d.firstAt < this.#clearedAt) {
        this.#events.onLog(`decide dropped (cleared): ${d.lang ?? 'none'} ${quote(d.text)}`);
        continue;
      }
      const rejected = d.rejected.map((f) => `${f.lang}:${quote(f.text)}`).join(' ');
      this.#events.onLog(`decide ${d.lang ?? 'none'} ${quote(d.text)}${rejected ? ` rejected ${rejected}` : ''}`);
      if (!d.lang) continue;
      const u = this.#paragrapher.add({ lang: d.lang, text: d.text, firstAt: d.firstAt });
      const { key, text } = u.paragraph;
      this.#events.onLog(`paragraph #${key} ${u.kind}${u.closed ? ` (closed: ${u.closed})` : ''}`);
      const id = this.#nextId++;
      this.#queue.push({ id, key, text, from: d.lang, to: other(d.lang), firstAt: d.firstAt });
      this.#events.onParagraph(id, u);
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
