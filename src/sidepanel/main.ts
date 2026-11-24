import { LangDetector } from '../asr/langDetect';
import type { PrepareProgress, TranslatorBackend } from '../mt/backend';
import { ChromeBackend } from '../mt/chrome';
import { PlamoBackend } from '../mt/plamo/backend';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { loadTarget, onTargetChange, type Target } from '../shared/target';
import { speechRecognition } from '../types/web-ai';
import { Session } from './session';
import { CONTROLS, next, type Control, type Event, type State } from './state';
import { bindSettingsForm, byId, DebugView, SubtitleView } from './ui';

const LOCALES = ['ja-JP', 'en-US'];
const ENGINE_LABEL = { plamo: 'PLaMo', chrome: 'Chrome 翻訳' } as const;

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A synchronous throw (no SpeechRecognition at all, say) as a rejection, so that 準備 still settles. */
const attempt = <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return f();
  } catch (e) {
    return Promise.reject(e);
  }
};

const buttons: Record<Exclude<Control, 'engine'>, HTMLButtonElement> = {
  prepare: byId('prepare'),
  start: byId('start'),
  stop: byId('stop'),
  clear: byId('clear'),
  reset: byId('reset'),
  close: byId('close'),
};
const engineSelect = byId<HTMLSelectElement>('engine');
const messageEl = byId('message');
const titleEl = byId('target-title');
const readinessEl = { langs: byId('ready-langs'), detector: byId('ready-detector'), engine: byId('ready-engine') };
const subtitles = new SubtitleView(byId('subtitles'), byId('utterances'), byId('interim'));
const debug = new DebugView(byId('rejected'), byId('latency'), byId('log'));
const log = debug.log;

let settings: Settings = await loadSettings();
let state: State = 'idle';
let message = '「準備」を押してください';
const readiness = { langs: '未準備', detector: '未準備', engine: '未準備' };
const makeBackend = (engine: Settings['engine']): TranslatorBackend =>
  engine === 'plamo' ? new PlamoBackend({ onLog: log }) : new ChromeBackend();
let backend = makeBackend(settings.engine);
/** The previous engine's dispose(): PLaMo waits for it, so that two models are never loaded. */
let disposing: Promise<void> = Promise.resolve();
let detector: LangDetector | null = null;
let session: Session | null = null;
/** Counts the sessions started, to tell their job ids apart. */
let runs = 0;
const windowId = (await chrome.windows.getCurrent()).id;
let target: Target | null = null;

function dispatch(event: Event, text?: string): boolean {
  const to = next(state, event);
  if (!to) return false;
  if (to !== state) log(`state ${state} --${event}--> ${to}`);
  state = to;
  if (text !== undefined) message = text;
  render();
  return true;
}

function render(): void {
  const enabled = CONTROLS[state];
  for (const [control, button] of Object.entries(buttons)) button.disabled = !enabled.includes(control as Control);
  engineSelect.disabled = !enabled.includes('engine');
  engineSelect.value = backend.id;
  messageEl.textContent = message;
  messageEl.classList.toggle('error', state === 'error');
  readinessEl.langs.textContent = readiness.langs;
  readinessEl.detector.textContent = readiness.detector;
  readinessEl.engine.textContent = readiness.engine;
  titleEl.textContent = target ? target.title || `タブ ${target.tabId}` : '（アイコンを押したタブ）';
}

function engineReadiness(b: TranslatorBackend, p?: PrepareProgress): string {
  const label = ENGINE_LABEL[b.id];
  if (p?.phase === 'download') return `${label}: モデルをダウンロード中 ${Math.floor((p.ratio ?? 0) * 100)}%（閉じると中断されます）`;
  if (p?.phase === 'load') return `${label}: 読み込み中`;
  if (!b.ready) return `${label}: 未準備`;
  return b instanceof PlamoBackend ? `${label}（${b.device}）` : label;
}

/** Each step reports into the readiness line `key`, and rejects with its label. */
function step<T>(key: keyof typeof readiness, label: string, work: Promise<T>, done: (v: T) => string): Promise<T> {
  readiness[key] = '準備中…';
  return work.then(
    (v) => {
      readiness[key] = done(v);
      render();
      return v;
    },
    (e: unknown) => {
      readiness[key] = `失敗: ${err(e)}`;
      render();
      throw new Error(`${label}: ${err(e)}`);
    },
  );
}

// Everything is started inside the click without awaiting in between: install() and
// Translator.create() need the user gesture while their models are downloadable.
buttons.prepare.addEventListener('click', () => {
  if (!dispatch('prepare', '準備中…')) return;
  const preparing = backend;
  const start = performance.now();
  const onProgress = (p: PrepareProgress) => {
    readiness.engine = engineReadiness(preparing, p);
    render();
  };
  const tasks = [
    step('langs', '言語パック', attempt(() => speechRecognition().install({ langs: LOCALES, processLocally: true })), (ok) => {
      if (!ok) throw new Error('install() が false を返しました');
      return 'ja-JP / en-US';
    }),
    step('detector', '言語判定', detector ? Promise.resolve(detector) : LangDetector.create(), (d) => {
      detector = d;
      return '準備済み';
    }),
    step(
      'engine',
      ENGINE_LABEL[preparing.id],
      // Chrome's Translator.create() must start within the click; PLaMo needs no gesture.
      preparing instanceof PlamoBackend ? disposing.then(() => preparing.prepare(onProgress)) : preparing.prepare(onProgress),
      () => engineReadiness(preparing),
    ),
  ];
  void Promise.allSettled(tasks).then((results) => {
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [err(r.reason)] : []));
    if (failed.length) {
      for (const f of failed) log(`prepare failed: ${f}`);
      dispatch('prepareFailed', `準備に失敗しました。もう一度押してください（${failed.join(' / ')}）`);
      return;
    }
    log(`prepared ${preparing.id} in ${Math.round(performance.now() - start)}ms`);
    dispatch('prepared', '準備できました。「開始」を押してください');
  });
});

buttons.start.addEventListener('click', async () => {
  if (backend instanceof PlamoBackend && backend.reloading) {
    message = 'PLaMo を読み込み直しています。少し待ってから「開始」を押してください';
    render();
    return;
  }
  if (!backend.ready) {
    // PLaMo failed to load again after a crash, for example.
    readiness.engine = engineReadiness(backend);
    dispatch('lost', `${ENGINE_LABEL[backend.id]}が使えません。「準備」を押し直してください`);
    return;
  }
  // Before any await: a second click would try to capture the tab twice.
  if (!dispatch('start', '開始中…')) return;
  const tab = target;
  if (!tab || !detector) {
    dispatch('startFailed', tab ? '先に「準備」を押してください' : '対象タブがありません。会議のタブでアイコンを押してください');
    void loadTarget().then(acceptTarget);
    return;
  }
  const run = ++runs;
  try {
    session = await Session.start({
      tabId: tab.tabId,
      settings,
      detect: detector.detect,
      backend,
      events: {
        onInterim: (i) => subtitles.setInterim(i),
        onDecision: (id, d) => {
          debug.addRejected(d);
          if (id !== null && d.lang) subtitles.add(run, id, { ...d, lang: d.lang });
        },
        onTranslation: (o) => {
          subtitles.setOutcome(run, o);
          if (o.kind === 'done') {
            const latency = Math.round(o.finishedAt - o.job.firstAt);
            debug.addLatency(latency);
            log(`translate #${o.job.id} ${Math.round(o.finishedAt - o.startedAt)}ms, from firstAt ${latency}ms`);
          } else if (o.kind === 'failed') {
            log(`translate #${o.job.id} failed: ${o.reason} ${o.message}`);
          } else {
            log(`translate #${o.job.id} skipped`);
          }
        },
        onEnded: (reason, fatal) => {
          session = null;
          subtitles.setInterim(null);
          if (fatal) dispatch('fail', reason ?? '停止しました');
          else dispatch('ended', reason ?? '停止しました');
          // A target set in this window while running was held back.
          void loadTarget().then(acceptTarget);
        },
        onLog: log,
      },
    });
    dispatch('started', `認識中（${tab.title || `タブ ${tab.tabId}`}）`);
  } catch (e) {
    log(`start failed: ${err(e)}`);
    dispatch('startFailed', `開始できませんでした: ${err(e)}`);
    // A target set in this window while starting was held back.
    void loadTarget().then(acceptTarget);
  }
});

buttons.stop.addEventListener('click', () => {
  if (!dispatch('stop', '停止中…')) return;
  void session?.stop();
});

buttons.clear.addEventListener('click', () => {
  subtitles.clear();
  backend.clearContext();
  log('cleared');
});

buttons.reset.addEventListener('click', () => {
  dispatch('reset', '「準備」を押してください');
});

buttons.close.addEventListener('click', () => {
  if (windowId !== undefined) void chrome.sidePanel.close({ windowId });
});

// Only in idle and ready: switching while translating would dispose() the engine under the job
// in progress. The new engine needs 準備, and the previous one is disposed to free PLaMo's GPU memory.
engineSelect.addEventListener('change', () => {
  const engine = engineSelect.value as Settings['engine'];
  if (engine === backend.id) return;
  const previous = backend;
  backend = makeBackend(engine);
  if (!dispatch('engineChanged', '翻訳エンジンを替えました。「準備」を押してください')) {
    backend = previous;
    render();
    return;
  }
  readiness.engine = engineReadiness(backend);
  render();
  disposing = disposing.then(() => previous.dispose()).then(
    () => log(`${previous.id} disposed, engine=${engine}`),
    (e: unknown) => log(`${previous.id} dispose failed: ${err(e)}`),
  );
  settings = { ...settings, engine };
  void saveSettings(settings);
});

bindSettingsForm(byId<HTMLFormElement>('settings'), settings, (patch) => {
  settings = { ...settings, ...patch };
  void saveSettings(settings);
  log(`settings ${JSON.stringify(patch)}`);
});

byId('copy-log').addEventListener('click', () => void navigator.clipboard.writeText(debug.logText));
byId('clear-log').addEventListener('click', () => debug.clearLog());

/**
 * The target is shared by every window (storage.session): a panel takes only the one set in its
 * own window, and keeps its target while a session may be using it.
 */
function acceptTarget(t: Target | null): void {
  if (!t || t.windowId !== windowId) return;
  if (state === 'starting' || state === 'running' || state === 'stopping') {
    if (t.tabId !== target?.tabId) log(`target ${t.tabId} held back while ${state}`);
    return;
  }
  target = t;
  render();
}

// Listen before reading, so that a change made while reading is not missed.
onTargetChange(acceptTarget);
acceptTarget(await loadTarget());
render();
log(`Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'}, window ${windowId}`);
