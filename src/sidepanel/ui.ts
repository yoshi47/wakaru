import type { ParagraphUpdate } from '../asr/paragrapher';
import type { Outcome } from '../mt/queue';
import type { Lang } from '../shared/lang';

/** Subtitles (paragraphs) kept on screen. */
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

/**
 * One subtitle on screen. `latest` is the job translating its latest version, and `settled`
 * whether its outcome came: an earlier version's translation may come after it (the latest was
 * skipped while the earlier one ran).
 */
type Shown = { source: HTMLElement; translation: HTMLElement; latest: number; translated: boolean; settled: boolean };

const failure = (o: Exclude<Outcome, { kind: 'done' }>) =>
  o.kind === 'skipped' ? '翻訳待ちが多いため省略' : `翻訳できませんでした（${o.reason === 'timeout' ? '時間切れ' : o.message}）`;

/** The translation shown is of an earlier version, and will stay so: says the rest is missing. */
function behind(t: HTMLElement, why: string): void {
  t.classList.remove('stale');
  t.querySelector('.note')?.remove();
  t.append(el('span', { className: 'note', textContent: '続きは訳せませんでした', title: why }));
}

/**
 * The subtitles: one block per paragraph (source with its language, then the translation). A
 * paragraph that grows is translated again: meanwhile its earlier translation stays, dimmed
 * (`stale`), rather than flashing back to 翻訳中 with each piece.
 */
export class SubtitleView {
  readonly #scroller: HTMLElement;
  readonly #list: HTMLOListElement;
  readonly #interim: HTMLElement;
  /**
   * By `${run}:${paragraph key}`: a session numbers its paragraphs from 1, so the keys of the
   * runs before it are seen again.
   */
  readonly #shown = new Map<string, Shown>();

  constructor(scroller: HTMLElement, list: HTMLOListElement, interim: HTMLElement) {
    this.#scroller = scroller;
    this.#list = list;
    this.#interim = interim;
  }

  /** A paragraph started or grew. One that クリア removed shows again, with this version. */
  show(run: number, jobId: number, u: ParagraphUpdate): void {
    const key = `${run}:${u.paragraph.key}`;
    this.#follow(() => {
      const shown = this.#shown.get(key) ?? this.#create(key, u.paragraph.lang);
      shown.source.textContent = u.paragraph.text;
      shown.latest = jobId;
      shown.settled = false;
      const t = shown.translation;
      if (shown.translated) {
        t.classList.add('stale');
        t.querySelector('.note')?.remove();
      } else if (t.classList.contains('error')) {
        // The earlier version failed: this one is under way.
        t.classList.replace('error', 'pending');
        t.textContent = '翻訳中';
      }
    });
  }

  setOutcome(run: number, o: Outcome): void {
    const shown = this.#shown.get(`${run}:${o.job.key}`);
    if (!shown) return;
    const latest = o.job.id === shown.latest;
    const t = shown.translation;
    if (o.kind !== 'done' && !latest) return;
    if (latest) shown.settled = true;
    this.#follow(() => {
      t.classList.remove('pending');
      if (o.kind === 'done') {
        t.classList.remove('error');
        t.textContent = o.translation;
        shown.translated = true;
        if (latest) t.classList.remove('stale');
        // An earlier version, after the latest failed: nothing newer will come.
        else if (shown.settled) behind(t, '最新の版は訳せませんでした');
        else t.classList.add('stale');
      } else if (!shown.translated) {
        t.classList.add('error');
        t.textContent = failure(o);
      } else {
        // The translation of an earlier version stays, rather than an error in its place.
        behind(t, failure(o));
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

  /**
   * At the end of a run: the hero may come back if nothing became a subtitle. A translation still
   * dimmed is of an earlier version, and stays so: stop gives up waiting after a while.
   */
  endRun(): void {
    this.setInterim(null);
    delete this.#scroller.dataset.heard;
    for (const { translation } of this.#shown.values()) {
      if (translation.classList.contains('stale')) behind(translation, '停止したため');
    }
  }

  scrollToLatest(): void {
    this.#scroller.scrollTo({ top: this.#scroller.scrollHeight, behavior: 'smooth' });
  }

  clear(): void {
    this.#list.replaceChildren();
    this.#shown.clear();
    this.#interim.textContent = '';
    // data-heard stays while a run goes on (only endRun() drops it): the hero would flash back.
  }

  #create(key: string, lang: Lang): Shown {
    const li = el('li', { className: 'utterance' });
    li.dataset.key = key;
    li.dataset.lang = lang;
    const source = el('span');
    const head = el('div', { className: 'source' });
    head.append(el('span', { className: 'lang', textContent: lang.toUpperCase() }), source);
    const translation = el('p', { className: 'translation pending', textContent: '翻訳中' });
    li.append(head, translation);
    this.#list.append(li);
    const shown: Shown = { source, translation, latest: 0, translated: false, settled: false };
    this.#shown.set(key, shown);
    while (this.#list.children.length > MAX_UTTERANCES) {
      const first = this.#list.firstElementChild as HTMLElement;
      this.#shown.delete(first.dataset.key ?? '');
      first.remove();
    }
    return shown;
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
