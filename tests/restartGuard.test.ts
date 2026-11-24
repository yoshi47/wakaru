import { describe, expect, it } from 'vitest';
import { RestartGuard } from '../src/asr/restartGuard';

describe('RestartGuard', () => {
  it('ignores sessions that lasted at least a second', () => {
    const g = new RestartGuard();
    for (let i = 0; i < 100; i++) expect(g.ended(i * 1000, i * 1000 + 1000)).toBe(true);
  });

  it('gives up on the 6th session within 10 seconds that ended within a second of starting', () => {
    const g = new RestartGuard();
    for (let i = 0; i < 5; i++) expect(g.ended(i * 100, i * 100 + 50)).toBe(true);
    expect(g.ended(600, 650)).toBe(false);
  });

  it('forgets abnormal ends older than 10 seconds', () => {
    const g = new RestartGuard();
    for (let i = 0; i < 5; i++) g.ended(i * 100, i * 100 + 50);
    // The first one ended at 50; 10050 is 10 seconds later, so it no longer counts.
    expect(g.ended(10_000, 10_050)).toBe(true);
  });
});
