import type { Decision } from '../asr/arbiter';
import type { Outcome } from '../mt/queue';
import type { Lang } from '../shared/lang';

const MAX_UTTERANCES = 500;
const MAX_LOG_LINES = 3000;
/** Within this of the bottom counts as at the bottom: the list keeps following new lines. */
const STICK_PX = 32;

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  return e;
}

/** One preparation step: its state, and what to show while it runs or after it failed. */
export type Check = { status: 'pending' | 'working' | 'ok' | 'error'; detail: string; ratio?: number };

/** The subtitles: one block per utterance (source with its language, then the translation). */
export class SubtitleView {
  readonly #scroller: HTMLElement;
  readonly #list: HTMLOListElement;
  readonly #interim: HTMLElement;
  /**
   * By `${run}:${job id}`: a session numbers its jobs from 1, so the ids of the runs before it are
   * seen again.
   */
  readonly #translations = new Map<string, HTMLElement>();

  constructor(scroller: HTMLElement, list: HTMLOListElement, interim: HTMLElement) {
    this.#scroller = scroller;
    this.#list = list;
    this.#interim = interim;
  }

  add(run: number, id: number, d: Decision & { lang: Lang }): void {
    this.#follow(() => {
      const li = el('li', { className: 'utterance' });
      const key = `${run}:${id}`;
      li.dataset.key = key;
      li.dataset.lang = d.lang;
      const source = el('div', { className: 'source' });
      source.append(el('span', { className: 'lang', textContent: d.lang.toUpperCase() }), el('span', { textContent: d.text }));
      const translation = el('p', { className: 'translation pending', textContent: '翻訳中' });
      li.append(source, translation);
      this.#list.append(li);
      this.#translations.set(key, translation);
      while (this.#list.children.length > MAX_UTTERANCES) {
        const first = this.#list.firstElementChild as HTMLElement;
        this.#translations.delete(first.dataset.key ?? '');
        first.remove();
      }
    });
  }

  setOutcome(run: number, o: Outcome): void {
    const target = this.#translations.get(`${run}:${o.job.id}`);
    if (!target) return;
    this.#follow(() => {
      target.classList.remove('pending');
      if (o.kind === 'done') {
        target.textContent = o.translation;
      } else {
        target.classList.add('error');
        target.textContent =
          o.kind === 'skipped'
            ? '翻訳待ちが多いため省略'
            : `翻訳できませんでした（${o.reason === 'timeout' ? '時間切れ' : o.message}）`;
      }
    });
  }

  setInterim(interim: { lang: Lang; text: string } | null): void {
    this.#follow(() => {
      this.#interim.textContent = interim?.text ?? '';
      // Something was heard: the hero stays away for the rest of the run, also in the gap between a
      // final clearing the interim line and its decision adding the subtitle (up to windowMs).
      if (interim?.text) this.#scroller.dataset.heard = '';
    });
  }

  /** At the end of a run: the hero may come back if nothing became a subtitle. */
  endRun(): void {
    this.setInterim(null);
    delete this.#scroller.dataset.heard;
  }

  scrollToLatest(): void {
    this.#scroller.scrollTo({ top: this.#scroller.scrollHeight, behavior: 'smooth' });
  }

  clear(): void {
    this.#list.replaceChildren();
    this.#translations.clear();
    this.#interim.textContent = '';
    // data-heard stays while a run goes on (only endRun() drops it): the hero would flash back.
  }

  /** Runs `change`, then keeps the list at the bottom if it was there: not while the user reads above. */
  #follow(change: () => void): void {
    const s = this.#scroller;
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight <= STICK_PX;
    change();
    if (atBottom) s.scrollTop = s.scrollHeight;
  }
}

/** The log of the settings sheet, to copy into a bug report. */
export class LogView {
  readonly #log: HTMLTextAreaElement;
  readonly #t0 = performance.now();
  #lines: string[] = [];

  constructor(log: HTMLTextAreaElement) {
    this.#log = log;
  }

  readonly log = (message: string): void => {
    const line = `${new Date().toISOString().slice(11, 23)} +${Math.round(performance.now() - this.#t0)}ms ${message}`;
    this.#lines.push(line);
    // A long meeting logs every final and decision: the oldest lines go.
    if (this.#lines.length > MAX_LOG_LINES) this.#lines.splice(0, this.#lines.length - MAX_LOG_LINES);
    this.#log.value = this.#lines.join('\n');
    this.#log.scrollTop = this.#log.scrollHeight;
  };

  get logText(): string {
    return this.#lines.join('\n') + '\n';
  }

  clearLog(): void {
    this.#lines = [];
    this.#log.value = '';
  }
}
