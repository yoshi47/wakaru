import { describe, expect, it } from 'vitest';
import utterances from '../dev/utterances.json';
import { normalize, normalizeJa } from '../src/asr/normalize';

const withoutPunctuation = (text: string) => text.replace(/[、。？！]/g, '');

describe('normalizeJa', () => {
  it('removes spaces next to CJK characters', () => {
    expect(normalizeJa('来週 の リリース')).toBe('来週のリリース');
    expect(normalizeJa('Slack に 共有')).toBe('Slackに共有');
    expect(normalizeJa('WEB 版 の 方 です')).toBe('WEB版の方です');
  });

  it('keeps one space between Latin words', () => {
    expect(normalizeJa('API  rate の 制限')).toBe('API rateの制限');
  });

  it('trims the leading space Chrome puts on some finals', () => {
    expect(normalizeJa(' OK')).toBe('OK');
    expect(normalizeJa(' はい ')).toBe('はい');
  });

  // FINALs that Chrome 157 returned for dev/player.html in Task 1, with the utterance they came from.
  it.each([
    ['来週 の リリース に つい て スケジュール を 確認 さ せ て ください', 0],
    ['了解 です テスト は もう 終わっ て い ます か', 2],
    ['その 件 は 一旦 持ち帰っ て チーム 内 で 検討 さ せ て ください', 10],
    ['すみ ませ ん ちょっと 音声 が 途切れ て い まし た もう 一度 お 願い でき ます か', 14],
    ['なるほど それ なら キャッシュ を 入れれ ば 解決 し そう です ね', 16],
    ['承知 し まし た 今週 中 に 対応 し ます', 18],
  ])('turns the recognized "%s" back into utterance %i', (final, index) => {
    const utterance = utterances[index];
    expect(utterance?.lang).toBe('ja');
    expect(normalizeJa(final)).toBe(withoutPunctuation(utterance?.text ?? ''));
  });
});

describe('normalize', () => {
  it('collapses and trims spaces in English', () => {
    expect(normalize('en', ' Most of the  tests are done ')).toBe('Most of the tests are done');
  });

  it('drops the recognizer’s end-of-sentence token', () => {
    expect(normalize('en', 'E </S>')).toBe('E');
    expect(normalize('en', 'Hi </S>')).toBe('Hi');
    expect(normalize('en', 'What is temperature </S>')).toBe('What is temperature');
    expect(normalize('ja', 'はい </S>')).toBe('はい');
  });

  it('applies normalizeJa to Japanese', () => {
    expect(normalize('ja', ' 来週 の リリース')).toBe('来週のリリース');
  });
});
