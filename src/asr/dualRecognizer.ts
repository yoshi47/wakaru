import type { Lang } from '../shared/lang';
import { speechRecognition, type Recognition, type RecognitionErrorEvent } from '../types/web-ai';
import { RestartGuard } from './restartGuard';

export type RecognizerEvents = {
  onInterim(lang: Lang, generation: number, text: string): void;
  onFinal(lang: Lang, generation: number, text: string): void;
  /** A generation ended by itself and is about to be replaced. Its interim got no final. */
  onEnd(lang: Lang, generation: number): void;
  /** Both recognizers have stopped and will not restart. */
  onFatal(lang: Lang, error: string): void;
  /** For the debug log. */
  onLog?(message: string): void;
};

const LOCALES: Record<Lang, string> = { ja: 'ja-JP', en: 'en-US' };

// Errors that a restart cannot fix: permissions, the language, the audio source. `network` should
// never come on-device; if it does, audio may be leaving the machine, so stop rather than retry.
const FATAL = new Set(['network', 'service-not-allowed', 'not-allowed', 'language-not-supported', 'audio-capture']);

type Slot = { rec: Recognition; generation: number; startedAt: number; track: MediaStreamTrack };

export class OnDeviceUnavailableError extends Error {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The ja and en on-device recognizers on the same tab audio. A recognizer that ends is replaced,
 * and every start gets a new generation number; events from older generations are dropped.
 */
export class DualRecognizer {
  readonly #source: MediaStreamTrack;
  readonly #events: RecognizerEvents;
  readonly #now: () => number;
  readonly #slots = new Map<Lang, Slot>();
  readonly #guards = new Map<Lang, RestartGuard>();
  #generation = 0;
  #running = false;

  constructor(source: MediaStreamTrack, events: RecognizerEvents, now: () => number = () => performance.now()) {
    this.#source = source;
    this.#events = events;
    this.#now = now;
  }

  start(): void {
    const SR = speechRecognition();
    // Why no fallback to processLocally = false: the audio would go to a cloud service.
    if (!('processLocally' in SR.prototype)) {
      throw new OnDeviceUnavailableError('このブラウザではオンデバイス音声認識が使えません');
    }
    this.#running = true;
    try {
      for (const lang of ['ja', 'en'] as const) {
        this.#guards.set(lang, new RestartGuard());
        this.#launch(lang);
      }
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  stop(): void {
    this.#running = false;
    for (const slot of this.#slots.values()) {
      slot.rec.abort();
      slot.track.stop();
    }
    this.#slots.clear();
  }

  #relaunch(lang: Lang): void {
    try {
      this.#launch(lang);
    } catch (e) {
      this.stop();
      this.#events.onFatal(lang, message(e));
    }
  }

  #launch(lang: Lang): void {
    const SR = speechRecognition();
    const rec = new SR();
    rec.lang = LOCALES[lang];
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = true;
    if (rec.processLocally !== true) {
      throw new OnDeviceUnavailableError('オンデバイス音声認識を有効にできませんでした');
    }
    const generation = ++this.#generation;
    const track = this.#source.clone();
    const slot: Slot = { rec, generation, startedAt: this.#now(), track };
    const current = () => this.#running && this.#slots.get(lang)?.generation === generation;

    rec.onresult = (e) => {
      if (!current()) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result?.[0]?.transcript ?? '';
        if (result?.isFinal) this.#events.onFinal(lang, generation, text);
        else interim += text;
      }
      this.#events.onInterim(lang, generation, interim);
    };
    rec.onerror = (e: RecognitionErrorEvent) => {
      if (!current()) return;
      this.#events.onLog?.(`${lang} error ${e.error} (gen ${generation})`);
      if (FATAL.has(e.error)) {
        this.stop();
        this.#events.onFatal(lang, e.error);
      }
      // Other errors (no-speech, aborted, ...) are followed by onend, which restarts.
    };
    rec.onend = () => {
      track.stop();
      if (!current()) return;
      this.#events.onEnd(lang, generation);
      if (!this.#guards.get(lang)?.ended(slot.startedAt, this.#now())) {
        this.stop();
        this.#events.onFatal(lang, 'too-many-restarts');
        return;
      }
      this.#relaunch(lang);
    };

    this.#slots.set(lang, slot);
    try {
      rec.start(track);
    } catch (e) {
      this.#slots.delete(lang);
      track.stop();
      throw e;
    }
  }
}
