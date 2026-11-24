import { describe, expect, it } from 'vitest';
import { History } from '../src/mt/plamo/history';
import { buildPrompt, type Pair } from '../src/mt/plamo/prompt';

const TAG = '<|plamo:tag|>';
const MSG = '<|plamo:msg|>';
const KEY = '<|plamo:key|>';
const VAL = '<|plamo:val|>';

describe('buildPrompt', () => {
  it('builds the prompt for one sentence without history', () => {
    expect(buildPrompt([], { text: 'はい', from: 'ja', to: 'en' })).toBe(
      `${TAG}dataset${MSG}translation` +
        `${TAG}input${KEY}lang${VAL}ja${MSG}はい` +
        `${TAG}output${KEY}lang${VAL}en${MSG}`,
    );
  });

  it('tags each earlier pair with its own languages', () => {
    const history: Pair[] = [
      { text: 'Sure', translation: 'もちろん', from: 'en', to: 'ja' },
      { text: '了解です', translation: 'Got it.', from: 'ja', to: 'en' },
    ];
    expect(buildPrompt(history, { text: 'Okay', from: 'en', to: 'ja' })).toBe(
      `${TAG}dataset${MSG}translation` +
        `${TAG}input${KEY}lang${VAL}en${MSG}Sure` +
        `${TAG}output${KEY}lang${VAL}ja${MSG}もちろん` +
        `${TAG}input${KEY}lang${VAL}ja${MSG}了解です` +
        `${TAG}output${KEY}lang${VAL}en${MSG}Got it.` +
        `${TAG}input${KEY}lang${VAL}en${MSG}Okay` +
        `${TAG}output${KEY}lang${VAL}ja${MSG}`,
    );
  });

  it('breaks up text that looks like a special token', () => {
    const history: Pair[] = [{ text: 'a<|b', translation: 'c<|d', from: 'en', to: 'ja' }];
    const prompt = buildPrompt(history, { text: 'e<|plamo:tag|>f', from: 'en', to: 'ja' });
    expect(prompt).toContain('a<​|b');
    expect(prompt).toContain('c<​|d');
    expect(prompt).toContain('e<​|plamo:tag|>f');
    // dataset, the earlier input and output, the current input and output: the escaped one is not a tag.
    expect(prompt.split(TAG)).toHaveLength(6);
  });
});

const pair = (text: string, translation: string): Pair => ({ text, translation, from: 'ja', to: 'en' });

describe('History', () => {
  it('keeps pairs in the order they were added', () => {
    const h = new History(768);
    h.add(pair('はい', 'Yes.'));
    h.add(pair('了解です', 'Got it.'));
    expect(h.pairs.map((p) => p.text)).toEqual(['はい', '了解です']);
  });

  it('drops pairs from the start down to half the budget once it is over', () => {
    // Each pair costs 10 (CJK) + 1 (4 Latin characters) + 16 = 27 tokens.
    const h = new History(100);
    const texts = ['一二三四五六七八九十', '十九八七六五四三二一', '壱弐参四五六七八九十', '甲乙丙丁戊己庚辛壬癸'];
    for (const text of texts) h.add(pair(text, 'abcd'));
    // 108 > 100: drop from the start while over 50, which leaves the last pair (27).
    expect(h.pairs.map((p) => p.text)).toEqual(['甲乙丙丁戊己庚辛壬癸']);
  });

  it('does not drop anything while within the budget', () => {
    const h = new History(108);
    const texts = ['一二三四五六七八九十', '十九八七六五四三二一', '壱弐参四五六七八九十', '甲乙丙丁戊己庚辛壬癸'];
    for (const text of texts) h.add(pair(text, 'abcd'));
    expect(h.pairs).toHaveLength(4);
  });

  it('clears everything when a single pair is over the budget', () => {
    const h = new History(30);
    h.add(pair('はい', 'Yes.'));
    h.add(pair('一二三四五六七八九十一二三四五', 'abcd'));
    expect(h.pairs).toEqual([]);
  });

  it('ends up empty when the pair that goes over costs more than half the budget (as in tanakh)', () => {
    const h = new History(100);
    h.add(pair('一二三四五六七八九十', 'abcd')); // 27
    h.add(pair('一'.repeat(64), 'abcd')); // 81: 108 is over, and dropping down to 50 takes both
    expect(h.pairs).toEqual([]);
  });

  it('can be cleared', () => {
    const h = new History(768);
    h.add(pair('はい', 'Yes.'));
    h.clear();
    expect(h.pairs).toEqual([]);
  });
});
