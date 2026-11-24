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

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
