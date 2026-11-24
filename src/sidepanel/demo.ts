// `sidepanel/index.html?demo`: sample subtitles and a state switcher, to judge the design without
// capturing a tab. Nothing here runs otherwise. The scenes set the state directly while the real
// handlers stay live: pressing the buttons here really prepares, and 停止 has no session to stop.

import type { Decision } from '../asr/arbiter';
import type { Outcome } from '../mt/queue';
import type { Lang } from '../shared/lang';
import type { State } from './state';
import type { Check, SubtitleView } from './ui';
type Readiness = { langs: Check; detector: Check; engine: Check };

export type DemoHooks = {
  subtitles: SubtitleView;
  set(state: State, message: string, readiness: Readiness): void;
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

const ok = (detail = ''): Check => ({ status: 'ok', detail });
const READY: Readiness = { langs: ok('日本語 · 英語'), detector: ok(), engine: ok('GPU で動いています') };

const SCENES: Record<State, [string, Readiness]> = {
  idle: ['「開始」を押すと、必要な言語パックや翻訳モデルをダウンロードしてから聞き取ります', { langs: { status: 'pending', detail: '' }, detector: { status: 'pending', detail: '' }, engine: { status: 'pending', detail: 'PLaMo' } }],
  preparing: ['準備しています', { langs: ok('日本語 · 英語'), detector: ok(), engine: { status: 'working', detail: 'PLaMo をダウンロード中（パネルを閉じると中断）', ratio: 0.45 } }],
  ready: ['「開始」を押すと、対象タブの音声を聞き取ります', READY],
  starting: ['開始しています', READY],
  running: ['「Weekly sync – Google Meet」の音声を聞き取っています', READY],
  stopping: ['停止しています', READY],
  error: ['音声認識（ja）が止まりました: audio-capture。「開始」でやり直します', READY],
};

const decision = (lang: Lang, text: string): Decision & { lang: Lang } => ({ lang, text, firstAt: 0, decidedAt: 0, rejected: [] });

export function mountDemo(hooks: DemoHooks): void {
  const { subtitles } = hooks;
  SAMPLES.forEach(([lang, text, translation], i) => {
    subtitles.add(0, i, decision(lang, text));
    if (translation === null) return;
    const job = { id: i, text, from: lang, to: (lang === 'ja' ? 'en' : 'ja') as Lang, firstAt: 0 };
    const outcome: Outcome =
      i === 4
        ? { kind: 'failed', job, reason: 'timeout', message: '', startedAt: 0, finishedAt: 0 }
        : { kind: 'done', job, translation, startedAt: 0, finishedAt: 0 };
    subtitles.setOutcome(0, outcome);
  });
  subtitles.setInterim({ lang: 'ja', text: '承知しました今週中に' });

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;inset:auto 8px 92px auto;display:flex;gap:4px;padding:4px;border-radius:8px;background:oklch(0% 0 0 / .7);z-index:10';
  const select = document.createElement('select');
  for (const state of Object.keys(SCENES)) select.append(new Option(state, state));
  select.value = 'running';
  const show = () => {
    const state = select.value as State;
    const [message, readiness] = SCENES[state];
    hooks.set(state, message, readiness);
  };
  select.addEventListener('change', show);
  bar.append(select);
  document.body.append(bar);
  show();
}
