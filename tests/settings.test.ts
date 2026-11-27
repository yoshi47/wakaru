import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFrom } from '../src/settings';

describe('settingsFrom', () => {
  it('starts in Japanese, with the microphone off', () => {
    const s = settingsFrom(undefined);
    expect(s.engine).toBe(DEFAULT_SETTINGS.engine);
    expect(s.langMode).toBe('ja');
    expect(s.mic).toBe(false);
  });

  it('turns the microphone on only when it was saved as true', () => {
    expect(settingsFrom({ mic: true }).mic).toBe(true);
    expect(settingsFrom({ mic: false }).mic).toBe(false);
    // An older settings object has no mic, or something else: do not start capturing.
    expect(settingsFrom({ mic: 'yes' as unknown as boolean }).mic).toBe(false);
  });

  it('keeps the valid fields it knows', () => {
    const s = settingsFrom({ engine: 'chrome', langMode: 'en', glossary: ['PLaMo'], mic: true });
    expect(s.engine).toBe('chrome');
    expect(s.langMode).toBe('en');
    expect(s.glossary).toEqual(['PLaMo']);
    expect(s.mic).toBe(true);
  });

  it('falls back for an unknown engine, language or glossary', () => {
    const s = settingsFrom({
      engine: 'other' as 'plamo',
      langMode: 'fr' as 'ja',
      glossary: ['ok', 1] as unknown as string[],
    });
    expect(s.engine).toBe(DEFAULT_SETTINGS.engine);
    expect(s.langMode).toBe('ja');
    expect(s.glossary).toEqual(DEFAULT_SETTINGS.glossary);
  });
});
