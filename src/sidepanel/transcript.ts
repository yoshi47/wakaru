import type { ParagraphUpdate } from '../asr/paragrapher';
import type { Outcome } from '../mt/queue';
import type { Lang } from '../shared/lang';

/** One paragraph of the export: its latest source, and the last translation that came. */
type Entry = { lang: Lang; source: string; translation: string | null; translatedJob: number };

const pad = (n: number) => String(n).padStart(2, '0');
/** Minute resolution is enough for a transcript. */
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * The record behind the export, kept apart from SubtitleView: the view drops the oldest of its 500
 * subtitles, and its nodes are the presentation. クリア empties it, like the subtitles.
 */
export class Transcript {
  readonly #entries = new Map<string, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  show(run: number, u: ParagraphUpdate): void {
    const key = this.#key(run, u.paragraph.key);
    const entry = this.#entries.get(key);
    if (entry) entry.source = u.paragraph.text;
    else
      this.#entries.set(key, {
        lang: u.paragraph.lang,
        source: u.paragraph.text,
        translation: null,
        translatedJob: 0,
      });
  }

  /**
   * The newest translation that came. One that failed leaves the earlier version in its place.
   * A job id that is not newer is ignored: the queue is serial today, but a late older result
   * must not overwrite the newer one.
   */
  setOutcome(run: number, o: Outcome): void {
    if (o.kind !== 'done') return;
    const entry = this.#entries.get(this.#key(run, o.job.key));
    if (!entry || o.job.id <= entry.translatedJob) return;
    entry.translation = o.translation;
    entry.translatedJob = o.job.id;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** The .md file: the source with its language, then its translation if one came. */
  toMarkdown(at: Date = new Date()): string {
    const lines = ['# wakaru 文字起こし', '', stamp(at), ''];
    for (const { lang, source, translation } of this.#entries.values()) {
      lines.push(`**${lang.toUpperCase()}** ${source}`, '');
      if (translation) lines.push(translation, '');
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  /** A session numbers its paragraphs from 1: the run keeps them apart. */
  #key(run: number, key: number): string {
    return `${run}:${key}`;
  }
}
