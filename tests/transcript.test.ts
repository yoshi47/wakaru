import { describe, expect, it } from 'vitest';
import type { ParagraphUpdate } from '../src/asr/paragrapher';
import type { Job, Outcome } from '../src/mt/queue';
import { Transcript } from '../src/sidepanel/transcript';

const update = (
  key: number,
  lang: 'ja' | 'en',
  text: string,
  kind: ParagraphUpdate['kind'] = 'new',
): ParagraphUpdate => ({
  kind,
  paragraph: { key, lang, text, pieces: [{ lang, text, firstAt: 0 }] },
  closed: null,
});

const job = (id: number, key: number, text: string, from: 'ja' | 'en' = 'ja'): Job => ({
  id,
  key,
  text,
  from,
  to: from === 'ja' ? 'en' : 'ja',
  firstAt: 0,
});

const done = (j: Job, translation: string): Outcome => ({
  kind: 'done',
  job: j,
  translation,
  startedAt: 0,
  finishedAt: 0,
});

const at = new Date(2026, 10, 27, 15, 30);

describe('Transcript', () => {
  it('keeps the latest source of a growing paragraph', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.show(1, update(1, 'ja', 'こんにちは、今日は', 'append'));

    expect(t.size).toBe(1);
    expect(t.toMarkdown(at)).toContain('**JA** こんにちは、今日は');
  });

  it('pairs the source with the last translation that came', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.setOutcome(1, done(job(1, 1, 'こんにちは'), 'Hello.'));

    expect(t.toMarkdown(at)).toBe(
      '# wakaru 文字起こし\n\n2026-11-27 15:30\n\n**JA** こんにちは\n\nHello.\n',
    );
  });

  it('keeps the earlier translation when the next one failed', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.setOutcome(1, done(job(1, 1, 'こんにちは'), 'Hello.'));
    t.show(1, update(1, 'ja', 'こんにちは、今日は', 'append'));
    t.setOutcome(1, {
      kind: 'failed',
      job: job(2, 1, 'こんにちは、今日は'),
      reason: 'timeout',
      message: '',
      startedAt: 0,
      finishedAt: 0,
    });

    expect(t.toMarkdown(at)).toContain('**JA** こんにちは、今日は\n\nHello.');
  });

  it('ignores a translation older than the one shown', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.show(1, update(1, 'ja', 'こんにちは、今日は', 'append'));
    t.setOutcome(1, done(job(2, 1, 'こんにちは、今日は'), 'Hello today.'));
    t.setOutcome(1, done(job(1, 1, 'こんにちは'), 'Hello.'));

    expect(t.toMarkdown(at)).toContain('**JA** こんにちは、今日は\n\nHello today.');
  });

  it('ignores an outcome for another run', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.setOutcome(2, done(job(1, 1, 'こんにちは'), 'Hello.'));

    expect(t.toMarkdown(at)).not.toContain('Hello.');
  });

  it('shows only the source when no translation came', () => {
    const t = new Transcript();
    t.show(1, update(1, 'en', 'OK'));
    t.setOutcome(1, { kind: 'skipped', job: job(1, 1, 'OK', 'en') });

    expect(t.toMarkdown(at)).toBe('# wakaru 文字起こし\n\n2026-11-27 15:30\n\n**EN** OK\n');
  });

  it('keeps the same paragraph key apart between runs', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', '一つ目'));
    t.show(2, update(1, 'ja', '二つ目'));

    const md = t.toMarkdown(at);
    expect(t.size).toBe(2);
    expect(md.indexOf('一つ目')).toBeLessThan(md.indexOf('二つ目'));
  });

  it('writes paragraphs in the order they started', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', '一つ目'));
    t.setOutcome(1, done(job(1, 1, '一つ目'), 'First.'));
    t.show(1, update(2, 'en', 'Second'));
    t.setOutcome(1, done(job(2, 2, 'Second', 'en'), '二つ目です。'));

    expect(t.toMarkdown(at)).toBe(
      '# wakaru 文字起こし\n\n2026-11-27 15:30\n\n**JA** 一つ目\n\nFirst.\n\n**EN** Second\n\n二つ目です。\n',
    );
  });

  it('clear empties the record', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.clear();

    expect(t.size).toBe(0);
    expect(t.toMarkdown(at)).toBe('# wakaru 文字起こし\n\n2026-11-27 15:30\n');
  });

  it('ignores outcomes for what クリア removed', () => {
    const t = new Transcript();
    t.show(1, update(1, 'ja', 'こんにちは'));
    t.clear();
    t.setOutcome(1, done(job(1, 1, 'こんにちは'), 'Hello.'));

    expect(t.size).toBe(0);
    expect(t.toMarkdown(at)).toBe('# wakaru 文字起こし\n\n2026-11-27 15:30\n');
  });
});
