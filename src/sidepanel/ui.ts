import type { Decision } from '../asr/arbiter';
import type { Outcome } from '../mt/queue';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import type { Lang } from '../shared/lang';

const MAX_UTTERANCES = 500;
const MAX_REJECTED = 200;
const MAX_LATENCIES = 500;
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

const time = () => new Date().toTimeString().slice(0, 8);

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
      const source = el('div', { className: 'source' });
      source.append(el('span', { className: `lang ${d.lang}`, textContent: d.lang.toUpperCase() }), ' ', d.text);
      const translation = el('div', { className: 'translation pending', textContent: '…' });
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
      this.#interim.textContent = interim ? `${interim.lang.toUpperCase()} ${interim.text}` : '';
    });
  }

  clear(): void {
    this.#list.replaceChildren();
    this.#translations.clear();
    this.#interim.textContent = '';
  }

  /** Runs `change`, then keeps the list at the bottom if it was there: not while the user reads above. */
  #follow(change: () => void): void {
    const s = this.#scroller;
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight <= STICK_PX;
    change();
    if (atBottom) s.scrollTop = s.scrollHeight;
  }
}

/** The debug section: dropped candidates, latency, and a log to copy back. */
export class DebugView {
  readonly #rejected: HTMLOListElement;
  readonly #latency: HTMLElement;
  readonly #log: HTMLTextAreaElement;
  readonly #latencies: number[] = [];
  #lines: string[] = [];
  readonly #t0 = performance.now();

  constructor(rejected: HTMLOListElement, latency: HTMLElement, log: HTMLTextAreaElement) {
    this.#rejected = rejected;
    this.#latency = latency;
    this.#log = log;
    this.#showLatency(null);
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

  addRejected(d: Decision): void {
    for (const f of d.rejected) {
      const why = d.lang ? `${d.lang.toUpperCase()} を採用` : 'どちらも無効';
      this.#rejected.prepend(el('li', { textContent: `${time()} ${f.lang.toUpperCase()}${f.synthetic ? '（確定扱い）' : ''} "${f.text}" — ${why}` }));
    }
    while (this.#rejected.children.length > MAX_REJECTED) this.#rejected.lastElementChild?.remove();
  }

  /** From the first final of an utterance to its translation. */
  addLatency(ms: number): void {
    this.#latencies.push(ms);
    if (this.#latencies.length > MAX_LATENCIES) this.#latencies.shift();
    this.#showLatency(ms);
  }

  #showLatency(last: number | null): void {
    const n = this.#latencies.length;
    if (!n || last === null) {
      this.#latency.textContent = '最初の確定から訳文まで: まだありません';
      return;
    }
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const median = sorted[Math.floor((n - 1) / 2)]!;
    const max = sorted[n - 1]!;
    this.#latency.textContent = `最初の確定から訳文まで: 直近 ${last}ms、中央値 ${median}ms、最大 ${max}ms（${n} 件）`;
  }
}

type Tunable = Omit<Settings, 'engine'>;
const NUMBERS = ['windowMs', 'enMinConfidence', 'enShortMinConfidence', 'stallMs'] as const;

/** The settings inputs of the debug section. Saved when valid; a session reads them when it starts. */
export function bindSettingsForm(form: HTMLFormElement, settings: Settings, onChange: (patch: Partial<Tunable>) => void): void {
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  for (const name of NUMBERS) {
    const field = input(name);
    field.value = String(settings[name]);
    field.placeholder = String(DEFAULT_SETTINGS[name]);
    field.addEventListener('change', () => {
      if (!field.checkValidity()) {
        field.reportValidity();
        return;
      }
      onChange({ [name]: Number(field.value) });
    });
  }
  const noise = input('noise');
  noise.checked = settings.noise;
  noise.addEventListener('change', () => onChange({ noise: noise.checked }));
  form.addEventListener('submit', (e) => e.preventDefault());
}
