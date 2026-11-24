import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/mt/tokens';

describe('estimateTokens', () => {
  it('counts one token per CJK character', () => {
    expect(estimateTokens('来週のリリース')).toBe(7);
  });

  it('counts one token per four Latin characters, rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('adds both kinds', () => {
    // 5 Latin characters (1.25) + 3 CJK characters
    expect(estimateTokens('Slackに共有')).toBe(5);
  });

  it('is 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
