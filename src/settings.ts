export type Settings = {
  engine: 'plamo' | 'chrome';
  windowMs: number;
  enMinConfidence: number;
  /** Used when ja is empty and en has at most 3 words. */
  enShortMinConfidence: number;
  stallMs: number;
  /** Mix -60 dBFS noise into the recognized audio (Task 1-6). */
  noise: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  engine: 'plamo',
  windowMs: 800,
  enMinConfidence: 0.9,
  enShortMinConfidence: 0.6,
  stallMs: 1200,
  noise: true,
};

/**
 * Only the engine is chosen by the user and kept. Why not the others: the panel no longer shows
 * them, so values stored by its earlier debug form would stick unseen, and tuned defaults would
 * never reach those users. Saving replaces whatever an earlier version stored.
 */
export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const engine = (settings as Partial<Settings> | undefined)?.engine;
  return { ...DEFAULT_SETTINGS, engine: engine === 'chrome' || engine === 'plamo' ? engine : DEFAULT_SETTINGS.engine };
}

export async function saveSettings(settings: Pick<Settings, 'engine'>): Promise<void> {
  await chrome.storage.local.set({ settings: { engine: settings.engine } });
}
