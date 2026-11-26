// `sidepanel/index.html?demo`: sample subtitles and a state switcher, to judge the design without
// capturing a tab. Nothing here runs otherwise. The scenes set the state directly; the primary
// action does nothing in demo (it would prepare for real), and 停止 has no session to stop.

import type { Piece } from '../asr/paragrapher';
import type { Outcome } from '../mt/queue';
import type { Lang } from '../shared/lang';
import type { State } from './state';
import type { Check, SubtitleView } from './ui';
type Readiness = { langs: Check; detector: Check; engine: Check };

export type DemoHooks = {
  subtitles: SubtitleView;
  set(state: State, message: string, readiness: Readiness, modelMissing: boolean, chromeAvailable: boolean): void;
};

// Utterances of dev/utterances.json, with translations PLaMo gave in Task 4.
const SAMPLES: [Lang, string, string | null][] = [
  ['ja', '来週のリリースについてスケジュールを確認させてください', 'Could you please confirm the schedule for next week’s release?'],
  ['en', 'Sure we are planning to ship the new feature on Wednesday', 'はい、新機能は水曜日にリリースする予定です。'],
  ['ja', '了解ですテストはもう終わっていますか', 'Got it. Are the tests finished already?'],
  ['en', 'Most of the tests are done but we still need to check the payment flow', 'テストはほぼ終わっていますが、決済フローの確認がまだ残っています。'],
  ['ja', 'OK', 'OK.'],
  ['en', 'No worries I said the API rate limit is causing the timeout errors', 'ご安心ください。API のレート制限がタイムアウトエラーの原因になっているとお伝えしました。'],
  ['ja', 'なるほどそれならキャッシュを入れれば解決しそうですね', 'I see. Then adding a cache should solve it.'],
  ['en', 'Exactly can you take the action item for that', null],
];

// One speaker in pieces, as in a meeting: the paragraph has grown since its first translation,
// which shows dimmed while the whole is translated again.
const GROWING: { lang: Lang; pieces: string[]; translation: string } = {
  lang: 'en',
  pieces: ['All right I finished the PR and then', 'I realized that it was not the only issue'],
  translation: 'よし、PR は終わりました。それから',
};

const ok = (detail = ''): Check => ({ status: 'ok', detail });
const READY: Readiness = { langs: ok('日本語 · 英語'), detector: ok(), engine: ok('GPU で動いています') };

const SCENES: Record<State, [string, Readiness, boolean?, boolean?]> = {
  idle: ['', { langs: { status: 'pending', detail: '' }, detector: { status: 'pending', detail: '' }, engine: { status: 'pending', detail: 'PLaMo' } }, true, true],
  preparing: ['準備しています', { langs: ok('日本語 · 英語'), detector: ok(), engine: { status: 'working', detail: 'PLaMo をダウンロード中', ratio: 0.45 } }],
  ready: ['「開始」を押すと、対象タブの音声を聞き取ります', READY],
  starting: ['開始しています', READY],
  running: ['「Weekly sync – Google Meet」の音声を聞き取っています', READY],
  stopping: ['停止しています', READY],
  error: ['音声認識（ja）が止まりました: audio-capture。「開始」でやり直します', READY],
};

const other = (lang: Lang): Lang => (lang === 'ja' ? 'en' : 'ja');

export function mountDemo(hooks: DemoHooks): void {
  const { subtitles } = hooks;
  let jobId = 0;
  /** Shows the paragraph `key` made of `pieces`, as its next version. */
  const show = (key: number, lang: Lang, pieces: string[]) => {
    const list: Piece[] = pieces.map((text) => ({ lang, text, firstAt: 0 }));
    const text = pieces.join(lang === 'ja' ? '' : ' ');
    const id = ++jobId;
    subtitles.show(0, id, { kind: pieces.length > 1 ? 'append' : 'new', paragraph: { key, lang, text, pieces: list }, closed: null });
    return { id, key, text, from: lang, to: other(lang), firstAt: 0 };
  };
  SAMPLES.forEach(([lang, text, translation], i) => {
    const job = show(i + 1, lang, [text]);
    if (translation === null) return;
    const outcome: Outcome =
      i === 4
        ? { kind: 'failed', job, reason: 'timeout', message: '', startedAt: 0, finishedAt: 0 }
        : { kind: 'done', job, translation, startedAt: 0, finishedAt: 0 };
    subtitles.setOutcome(0, outcome);
  });
  const key = SAMPLES.length + 1;
  const first = show(key, GROWING.lang, GROWING.pieces.slice(0, 1));
  subtitles.setOutcome(0, { kind: 'done', job: first, translation: GROWING.translation, startedAt: 0, finishedAt: 0 });
  show(key, GROWING.lang, GROWING.pieces);
  subtitles.setInterim({ lang: 'en', text: 'Like the document layouts' });

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;inset:auto 8px 92px auto;display:flex;gap:4px;padding:4px;border-radius:8px;background:oklch(0% 0 0 / .7);z-index:10';
  const select = document.createElement('select');
  for (const state of Object.keys(SCENES)) select.append(new Option(state, state));
  select.value = 'running';
  const showScene = () => {
    const state = select.value as State;
    const [message, readiness, missing, chrome] = SCENES[state];
    hooks.set(state, message, readiness, missing ?? false, chrome ?? false);
  };
  select.addEventListener('change', showScene);
  bar.append(select);
  document.body.append(bar);
  showScene();
}
