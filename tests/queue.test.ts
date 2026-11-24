import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationQueue, type Job, type Outcome } from '../src/mt/queue';

const job = (id: number): Job => ({ id, text: `text ${id}`, from: 'ja', to: 'en', firstAt: id * 100 });

/** A translate function whose calls finish when the test says so. */
function controlled() {
  const calls: { job: Job; signal: AbortSignal; resolve: (t: string) => void; reject: (e: Error) => void }[] = [];
  const translate = (j: Job, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => calls.push({ job: j, signal, resolve, reject }));
  return { calls, translate };
}

function setup(translate: (j: Job, signal: AbortSignal) => Promise<string>) {
  let time = 0;
  const outcomes: Outcome[] = [];
  const queue = new TranslationQueue({
    translate,
    onOutcome: (o) => outcomes.push(o),
    now: () => time,
  });
  return { queue, outcomes, setTime: (t: number) => (time = t) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('TranslationQueue', () => {
  it('translates one job at a time, in order', async () => {
    const { calls, translate } = controlled();
    const { queue, outcomes } = setup(translate);
    queue.push(job(1));
    queue.push(job(2));
    await settle();
    expect(calls.map((c) => c.job.id)).toEqual([1]);

    calls[0]!.resolve('one');
    await settle();
    expect(calls.map((c) => c.job.id)).toEqual([1, 2]);
    calls[1]!.resolve('two');
    await settle();
    expect(outcomes.map((o) => (o.kind === 'done' ? o.translation : o.kind))).toEqual(['one', 'two']);
  });

  it('records when each translation started and finished', async () => {
    const { calls, translate } = controlled();
    const { queue, outcomes, setTime } = setup(translate);
    setTime(1000);
    queue.push(job(1));
    await settle();
    setTime(1300);
    calls[0]!.resolve('one');
    await settle();
    expect(outcomes).toEqual([
      { kind: 'done', job: job(1), translation: 'one', startedAt: 1000, finishedAt: 1300 },
    ]);
  });

  it('aborts a translation after 5 seconds and moves on', async () => {
    vi.useFakeTimers();
    const { calls, translate } = controlled();
    const { queue, outcomes } = setup(translate);
    queue.push(job(1));
    queue.push(job(2));

    await vi.advanceTimersByTimeAsync(4999);
    expect(calls[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(outcomes[0]).toMatchObject({ kind: 'failed', job: job(1), reason: 'timeout' });
    expect(calls.map((c) => c.job.id)).toEqual([1, 2]);
  });

  it('leaves no timer behind after a translation finishes', async () => {
    vi.useFakeTimers();
    const { queue } = setup(async (j) => `done ${j.id}`);
    queue.push(job(1));
    await queue.drain();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps going when the outcome listener throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const queue = new TranslationQueue({
      translate: async (j) => `done ${j.id}`,
      onOutcome: () => {
        throw new Error('listener broke');
      },
      now: () => 0,
    });
    queue.push(job(1));
    queue.push(job(2));
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('reports a failed translation and moves on', async () => {
    const { calls, translate } = controlled();
    const { queue, outcomes } = setup(translate);
    queue.push(job(1));
    queue.push(job(2));
    await settle();
    calls[0]!.reject(new Error('device lost'));
    await settle();
    expect(outcomes[0]).toMatchObject({ kind: 'failed', job: job(1), reason: 'error', message: 'device lost' });
    expect(calls.map((c) => c.job.id)).toEqual([1, 2]);
  });

  it('skips the oldest waiting jobs when more than 5 are waiting', async () => {
    const { calls, translate } = controlled();
    const { queue, outcomes } = setup(translate);
    for (let id = 1; id <= 8; id++) queue.push(job(id));
    await settle();
    // 1 is being translated; 2 to 8 are waiting, which is 7: the oldest two are skipped.
    expect(outcomes).toEqual([
      { kind: 'skipped', job: job(2) },
      { kind: 'skipped', job: job(3) },
    ]);
    expect(queue.pending).toBe(5);

    for (let i = 0; i < 6; i++) {
      calls[i]!.resolve(`t${i}`);
      await settle();
    }
    expect(calls.map((c) => c.job.id)).toEqual([1, 4, 5, 6, 7, 8]);
  });

  it('drain() resolves once everything has been translated', async () => {
    const { calls, translate } = controlled();
    const { queue } = setup(translate);
    queue.push(job(1));
    queue.push(job(2));
    let drained = false;
    void queue.drain().then(() => (drained = true));
    await settle();
    calls[0]!.resolve('one');
    await settle();
    expect(drained).toBe(false);
    calls[1]!.resolve('two');
    await settle();
    expect(drained).toBe(true);
  });

  it('drain() resolves at once when there is nothing to do', async () => {
    const { queue } = setup(controlled().translate);
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
