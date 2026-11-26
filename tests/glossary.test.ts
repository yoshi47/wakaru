import { describe, expect, it } from 'vitest';
import { DEFAULT_GLOSSARY, phraseHints } from '../src/asr/glossary';

describe('phraseHints', () => {
  it('trims, drops empty lines, and removes duplicates', () => {
    expect(phraseHints([' 稟議 ', '', '広報', '稟議', '  '])).toEqual([
      { phrase: '稟議', boost: 3 },
      { phrase: '広報', boost: 3 },
    ]);
  });

  it('takes a boost', () => {
    expect(phraseHints(['会場'], 3)).toEqual([{ phrase: '会場', boost: 3 }]);
  });
});

describe('DEFAULT_GLOSSARY', () => {
  it('has the terms the 2026-11-25 meeting lost or mangled', () => {
    for (const term of ['稟議', '広報', '会場', 'TSKaigi']) expect(DEFAULT_GLOSSARY).toContain(term);
  });

  it('has no duplicates or blanks', () => {
    expect(new Set(DEFAULT_GLOSSARY).size).toBe(DEFAULT_GLOSSARY.length);
    expect(DEFAULT_GLOSSARY.every((t) => t.trim() === t && t.length > 0)).toBe(true);
  });
});
