// Types for the Web Speech API's on-device recognition, the Translator API and the Language
// Detector API, as far as wakaru uses them. Why not global declarations: lib.dom ships partial
// and changing versions of some of these names, and redeclaring them conflicts. These are read
// from globalThis under their own names instead.

export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export type RecognitionOptions = { langs: string[]; processLocally?: boolean };

export interface RecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

/** One contextual-bias hint for SpeechRecognition.phrases (Chrome 142+). */
export interface SpeechRecognitionPhrase {
  readonly phrase: string;
  readonly boost: number;
}
export interface SpeechRecognitionPhraseConstructor {
  new (phrase: string, boost?: number): SpeechRecognitionPhrase;
}
export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}
export interface RecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
export interface RecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

export interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  /** Contextual biasing; not in every build (see speechRecognitionPhrase()). */
  phrases?: SpeechRecognitionPhrase[];
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
}

export interface RecognitionConstructor {
  new (): Recognition;
  readonly prototype: Recognition;
  available(options: RecognitionOptions): Promise<Availability>;
  install(options: RecognitionOptions): Promise<boolean>;
}

export interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
export interface TranslatorStatic {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorInstance>;
}

export type DetectedLanguage = { detectedLanguage: string; confidence: number };
export interface LanguageDetectorInstance {
  detect(text: string): Promise<DetectedLanguage[]>;
  destroy(): void;
}
export interface LanguageDetectorStatic {
  availability(): Promise<Availability>;
  create(options?: { monitor?: (m: EventTarget) => void }): Promise<LanguageDetectorInstance>;
}

type WebAiGlobals = {
  SpeechRecognition?: RecognitionConstructor;
  SpeechRecognitionPhrase?: SpeechRecognitionPhraseConstructor;
  Translator?: TranslatorStatic;
  LanguageDetector?: LanguageDetectorStatic;
};
const g = globalThis as unknown as WebAiGlobals;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not available in this browser`);
  return value;
}

export const speechRecognition = (): RecognitionConstructor => required(g.SpeechRecognition, 'SpeechRecognition');
/** The phrase constructor for contextual biasing; undefined on builds without it (before 142). */
export const speechRecognitionPhrase = (): SpeechRecognitionPhraseConstructor | undefined => g.SpeechRecognitionPhrase;
export const translatorApi = (): TranslatorStatic => required(g.Translator, 'Translator');
export const languageDetectorApi = (): LanguageDetectorStatic => required(g.LanguageDetector, 'LanguageDetector');
