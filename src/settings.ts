import { DEFAULT_GLOSSARY } from './asr/glossary';

/** Which recognizers run. `ja` skips the English one, whose hallucinations cost a Japanese meeting. */
export type LangMode = 'auto' | 'ja' | 'en';

export type Settings = {
  engine: 'plamo' | 'chrome';
  langMode: LangMode;
  /** Terms the ja recognizer is biased towards (see asr/glossary.ts). */
  glossary: string[];
  windowMs: number;
  enMinConfidence: number;
  /** Used when ja is empty and en has at most 3 words. */
  enShortMinConfidence: number;
  stallMs: number;
  /** Mix -60 dBFS noise into the recognized audio (Task 1-6). */
  noise: boolean;
  /** The silence that closes a paragraph just started (see Paragrapher). */
  paragraphMaxGapMs: number;
  /** The silence that closes a paragraph at paragraphMaxTokens. */
  paragraphMinGapMs: number;
  /** A paragraph is not extended past this many estimated tokens. */
  paragraphMaxTokens: number;
};

export const DEFAULT_SETTINGS: Settings = {
  engine: 'plamo',
  // The panel starts in Japanese on a new install (see loadSettings); the harness and unit uses
  // keep both recognizers.
  langMode: 'auto',
  glossary: [...DEFAULT_GLOSSARY],
  windowMs: 800,
  enMinConfidence: 0.9,
  enShortMinConfidence: 0.6,
  stallMs: 1200,
  noise: true,
  paragraphMaxGapMs: 3000,
  paragraphMinGapMs: 1000,
  paragraphMaxTokens: 80,
};

const LANG_MODES: readonly string[] = ['auto', 'ja', 'en'];

/**
 * Only what the user chooses is kept: the engine, the language mode and the glossary. Why not the
 * tuning parameters: the panel no longer shows them, so values stored by its earlier debug form
 * would stick unseen, and tuned defaults would never reach those users. Saving replaces whatever
 * an earlier version stored.
 *
 * A new install starts in Japanese (the panel's language). English and mixed meetings are one
 * setting away; DEFAULT_SETTINGS keeps auto for the harness, which exercises both recognizers.
 */
export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const saved = settings as Partial<Settings> | undefined;
  const engine = saved?.engine;
  const langMode = saved?.langMode;
  const glossary = saved?.glossary;
  return {
    ...DEFAULT_SETTINGS,
    engine: engine === 'chrome' || engine === 'plamo' ? engine : DEFAULT_SETTINGS.engine,
    langMode: LANG_MODES.includes(langMode ?? '') ? (langMode as LangMode) : 'ja',
    glossary:
      Array.isArray(glossary) && glossary.every((s) => typeof s === 'string')
        ? [...glossary]
        : [...DEFAULT_SETTINGS.glossary],
  };
}

export async function saveSettings(settings: Pick<Settings, 'engine' | 'langMode' | 'glossary'>): Promise<void> {
  await chrome.storage.local.set({
    settings: { engine: settings.engine, langMode: settings.langMode, glossary: settings.glossary },
  });
}
