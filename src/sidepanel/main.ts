import { LangDetector } from '../asr/langDetect';
import type { PrepareProgress, TranslatorBackend } from '../mt/backend';
import { ChromeBackend } from '../mt/chrome';
import { PlamoBackend } from '../mt/plamo/backend';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { loadTarget, onTargetChange, type Target } from '../shared/target';
import { modelFile } from '../mt/plamo/modelStore';
import { languageDetectorApi, speechRecognition, translatorApi } from '../types/web-ai';
import { Session } from './session';
import { CONTROLS, next, type Control, type Event, type State } from './state';
import { byId, LogView, SubtitleView, type Check } from './ui';

const LOCALES = ['ja-JP', 'en-US'];
const ENGINE_LABEL = { plamo: 'PLaMo', chrome: 'Chrome 翻訳' } as const;

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A synchronous throw (no SpeechRecognition at all, say) as a rejection, so that preparing still settles. */
const attempt = <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return f();
  } catch (e) {
    return Promise.reject(e);
  }
};

const STATE_LABEL: Record<State, string> = {
  idle: '未準備',
  preparing: '準備中',
  ready: '準備完了',
  starting: '開始中',
  running: '聞き取り中',
  stopping: '停止中',
  error: 'エラー',
};

/** The top bar shows the one action of the state, or a spinner while it waits. */
const BUSY: ReadonlySet<State> = new Set(['preparing', 'starting', 'stopping']);

const buttons: Record<Exclude<Control, 'engine'>, HTMLButtonElement> = {
  start: byId('start'),
  stop: byId('stop'),
  clear: byId('clear'),
  close: byId('close'),
};
/** Shown (and only enabled) in their state; the others are icon buttons, disabled instead. */
const ACTIONS = new Set<Control>(['start', 'stop']);
const READY_MESSAGE = '「開始」を押すと、対象タブの音声を聞き取ります';
const FIRST_MESSAGE = '「開始」を押すと、必要な言語パックや翻訳モデルをダウンロードしてから聞き取ります';
const demo = new URLSearchParams(location.search).has('demo');
const busyButton = byId<HTMLButtonElement>('busy');
const actionsEl = document.querySelector<HTMLElement>('.actions')!;
const engineField = byId<HTMLFieldSetElement>('engine');
const engineInputs = [...engineField.querySelectorAll<HTMLInputElement>('input[name="engine"]')];
const messageEl = byId('message');
const progressEl = byId<HTMLProgressElement>('progress');
const engineNote = byId('engine-note');
const stateLabel = byId('state-label');
const titleEl = byId('target-title');
const bannerEl = byId('banner');
const heroText = byId('hero-text');
const heroStart = byId<HTMLButtonElement>('start-hero');
const utterancesEl = byId('utterances');
/** What the hero (shown until the first subtitle) says in the states that have no message of their own. */
const HERO_TEXT: Partial<Record<State, string>> = {
  starting: '開始しています',
  running: '話し始めると、ここに字幕が出ます',
  stopping: '停止しています',
  // The banner says what went wrong and that 開始 retries.
  error: '',
};
const STOPPED_MESSAGE = '停止しました。「開始」でもう一度聞き取ります';
const QUIET: ReadonlySet<State> = new Set(['starting', 'running', 'stopping']);
const engineStatus = byId('engine-status');
const subtitles = new SubtitleView(byId('subtitles'), byId('utterances'), byId('interim'));
const logView = new LogView(byId<HTMLTextAreaElement>('log'));
const log = logView.log;

let settings: Settings = await loadSettings();
let state: State = 'idle';
let message = '';
/** Each preparation step: the engine's shows in the banner and under the engine choice. */
const readiness: Record<'langs' | 'detector' | 'engine', Check> = {
  langs: { status: 'pending', detail: '' },
  detector: { status: 'pending', detail: '' },
  engine: { status: 'pending', detail: '' },
};
const makeBackend = (engine: Settings['engine']): TranslatorBackend => {
  if (engine === 'chrome') return new ChromeBackend();
  const plamo: PlamoBackend = new PlamoBackend({
    onLog: log,
    // A crash and its reload: the status under the engine choice follows.
    onChange: () => {
      if (backend !== plamo || state === 'preparing') return;
      readiness.engine = engineReadiness(plamo);
      render();
    },
  });
  return plamo;
};
let backend = makeBackend(settings.engine);
/** The previous engine's dispose(): PLaMo waits for it, so that two models are never loaded. */
let disposing: Promise<void> = Promise.resolve();
/** Advanced by 開始 and engine switches: an availability check they overtook does nothing. */
let autoToken = 0;
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
  // The action clicked is hidden by this render: focus follows to the one shown in its place. The
  // engine choice, disabled while preparing, lives in the settings sheet, away from the top bar:
  // its focus goes to the note saying why, which stays where the user is. (A hidden or disabled element loses focus at
  // once, so focus is checked against where it can no longer be.)
  const active = document.activeElement;
  const focusInActions = actionsEl.contains(active) || active === heroStart;
  const focusInEngine = engineField.contains(active);
  document.body.dataset.state = state;
  const enabled = CONTROLS[state];
  for (const [control, button] of Object.entries(buttons)) {
    const on = enabled.includes(control as Control);
    button.disabled = !on;
    if (ACTIONS.has(control as Control)) button.hidden = !on;
  }
  heroStart.hidden = !enabled.includes('start');
  heroStart.disabled = heroStart.hidden;
  busyButton.hidden = !BUSY.has(state);
  busyButton.setAttribute('aria-label', STATE_LABEL[state]);
  if (focusInActions && !actionsEl.contains(document.activeElement)) {
    actionsEl.querySelector<HTMLButtonElement>('button:not([hidden])')?.focus();
  }
  engineField.disabled = !enabled.includes('engine');
  engineNote.hidden = !engineField.disabled;
  // A hidden element referenced by aria-describedby is still read: only while it is shown.
  engineField.setAttribute('aria-describedby', engineField.disabled ? 'engine-status engine-note' : 'engine-status');
  if (focusInEngine && engineField.disabled) engineNote.focus();
  else if (document.activeElement === engineNote && !engineField.disabled) {
    engineField.querySelector<HTMLInputElement>('input:checked')?.focus();
  }
  for (const input of engineInputs) input.checked = input.value === backend.id;
  stateLabel.textContent = STATE_LABEL[state];
  // While preparing, the engine's step (a download takes minutes) says more than the message. The
  // percentage stays on the bar: in the live region it would be announced every 8MB.
  const engineStep = readiness.engine;
  const progress = state === 'preparing' && engineStep.status === 'working' ? engineStep : null;
  const text = progress?.detail || message;
  // Rewriting the same text is announced again by some screen readers.
  if (messageEl.textContent !== text) messageEl.textContent = text;
  progressEl.hidden = progress?.ratio === undefined;
  progressEl.value = progress?.ratio ?? 0;
  progressEl.setAttribute('aria-valuetext', `${Math.floor((progress?.ratio ?? 0) * 100)}%`);
  // Until the first subtitle the hero says it; while listening the top bar does. Kept as a live
  // region either way (see .banner[data-quiet]).
  const hasSubtitles = utterancesEl.childElementCount > 0;
  const quiet =
    !text ||
    (state !== 'error' &&
      progress?.ratio === undefined &&
      (!hasSubtitles || QUIET.has(state) || (state === 'ready' && (message === READY_MESSAGE || message === STOPPED_MESSAGE))));
  bannerEl.toggleAttribute('data-quiet', quiet);
  // While preparing, the step under way (a first download takes minutes) rather than a fixed line.
  heroText.textContent = state === 'preparing' ? progress?.detail || '準備しています' : (HERO_TEXT[state] ?? (text || READY_MESSAGE));
  engineStatus.textContent = engineStatusText();
  titleEl.textContent = target ? target.title || `タブ ${target.tabId}` : 'アイコンを押したタブ';
  titleEl.title = titleEl.textContent;
}

/** The line under the engine choice. */
function engineStatusText(): string {
  const { status, detail } = readiness.engine;
  // The detail, not a fixed line: the open sheet covers the banner that shows it too.
  if (status === 'working') return detail || '準備しています';
  if (status === 'error') return `準備できませんでした: ${detail}`;
  if (status === 'pending') return '「開始」を押すと準備します';
  return detail;
}

function engineReadiness(b: TranslatorBackend, p?: PrepareProgress): Check {
  const label = ENGINE_LABEL[b.id];
  if (p?.phase === 'download') {
    const ratio = p.ratio ?? 0;
    return { status: 'working', detail: `${label} をダウンロード中（パネルを閉じると中断）`, ratio };
  }
  if (p?.phase === 'load') return { status: 'working', detail: `${label} を読み込み中` };
  if (b instanceof PlamoBackend && b.reloading) return { status: 'working', detail: 'PLaMo を読み込み直しています' };
  if (!b.ready) return { status: 'pending', detail: label };
  if (!(b instanceof PlamoBackend)) return { status: 'ok', detail: '準備できています' };
  return { status: 'ok', detail: b.device?.startsWith('WebGPU') ? 'GPU で動いています' : 'CPU で動いています（遅め）' };
}

/** Each step reports into the readiness line `key`, and rejects with its label. */
function step<T>(key: keyof typeof readiness, label: string, work: Promise<T>, done: (v: T) => Check): Promise<T> {
  // The engine's progress replaces this; Chrome 翻訳 reports none, even while downloading.
  readiness[key] = { status: 'working', detail: key === 'engine' ? `${label} を準備しています` : '' };
  return work.then(
    (v) => {
      readiness[key] = done(v);
      render();
      return v;
    },
    (e: unknown) => {
      readiness[key] = { status: 'error', detail: err(e) };
      render();
      throw new Error(`${label}: ${err(e)}`);
    },
  );
}

/**
 * Starts preparing everything. Called synchronously within the 開始 click when something may need
 * downloading: install() and Translator.create() need the user gesture while their models are
 * downloadable, so nothing is awaited before they start. Settles with whether all is ready.
 */
function prepareAll(opts: { packsAvailable?: boolean } = {}): Promise<boolean> {
  const preparing = backend;
  const start = performance.now();
  const onProgress = (p: PrepareProgress) => {
    readiness.engine = engineReadiness(preparing, p);
    render();
  };
  const tasks = [
    // Why not install() when the packs are there already: outside a click it may be refused.
    step('langs', '言語パック', opts.packsAvailable ? Promise.resolve(true) : attempt(() => speechRecognition().install({ langs: LOCALES, processLocally: true })), (ok) => {
      if (!ok) throw new Error('install() が false を返しました');
      return { status: 'ok', detail: '日本語 · 英語' };
    }),
    step('detector', '言語判定', detector ? Promise.resolve(detector) : attempt(() => LangDetector.create()), (d) => {
      detector = d;
      return { status: 'ok', detail: '' };
    }),
    step(
      'engine',
      ENGINE_LABEL[preparing.id],
      // Chrome's Translator.create() must start within the click; PLaMo needs no gesture.
      preparing instanceof PlamoBackend ? disposing.then(() => preparing.prepare(onProgress)) : attempt(() => preparing.prepare(onProgress)),
      () => engineReadiness(preparing),
    ),
  ];
  render();
  return Promise.allSettled(tasks).then((results) => {
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [err(r.reason)] : []));
    if (failed.length) {
      for (const f of failed) log(`prepare failed: ${f}`);
      dispatch('prepareFailed', `準備できませんでした（${failed.join(' / ')}）。「開始」でもう一度試します`);
      return false;
    }
    log(`prepared ${preparing.id} in ${Math.round(performance.now() - start)}ms`);
    return dispatch('prepared', READY_MESSAGE);
  });
}

/** Whether everything is on this machine already, so that preparing needs no click. */
async function preparableWithoutClick(b: TranslatorBackend): Promise<boolean> {
  const SR = speechRecognition();
  const checks = [
    ...LOCALES.map((l) => SR.available({ langs: [l], processLocally: true })),
    languageDetectorApi().availability(),
    ...(b instanceof PlamoBackend
      ? [modelFile().then((f) => (f ? 'available' : 'downloadable'))]
      : [
          translatorApi().availability({ sourceLanguage: 'ja', targetLanguage: 'en' }),
          translatorApi().availability({ sourceLanguage: 'en', targetLanguage: 'ja' }),
        ]),
  ];
  return (await Promise.all(checks)).every((a) => a === 'available');
}

/** Prepares in the background when nothing needs downloading: 開始 then starts at once. */
async function autoPrepare(): Promise<void> {
  const token = ++autoToken;
  const b = backend;
  const ok = await preparableWithoutClick(b).catch((e: unknown) => {
    log(`availability check failed: ${err(e)}`);
    return false;
  });
  // The engine may have been switched, or 開始 pressed, while checking.
  if (token !== autoToken || b !== backend || state !== 'idle') return;
  if (!ok) {
    message = FIRST_MESSAGE;
    render();
    return;
  }
  if (dispatch('prepare', '準備しています')) await prepareAll({ packsAvailable: true });
}

function onStartClick(): void {
  if (demo) return;
  autoToken++;
  if (state === 'ready') {
    if (backend instanceof PlamoBackend && backend.reloading) {
      message = 'PLaMo を読み込み直しています。少し待ってから「開始」を押してください';
      render();
      return;
    }
    if (backend.ready) {
      void startSession();
      return;
    }
    // PLaMo failed to load again after a crash, for example: prepared again below.
    readiness.engine = engineReadiness(backend);
    dispatch('lost');
  }
  // From idle or error: prepare within this click, then start.
  if (!dispatch('start', '準備しています')) return;
  void prepareAll().then((ok) => {
    if (ok) void startSession();
  });
}

buttons.start.addEventListener('click', onStartClick);
heroStart.addEventListener('click', onStartClick);

async function startSession(): Promise<void> {
  // Before any await: a second click would try to capture the tab twice.
  if (!dispatch('start', '開始しています')) return;
  const tab = target;
  if (!tab || !detector) {
    dispatch('startFailed', tab ? '準備ができていません。もう一度「開始」を押してください' : '対象タブがありません。会議のタブでアイコンを押してください');
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
          if (id !== null && d.lang) subtitles.add(run, id, { ...d, lang: d.lang });
        },
        onTranslation: (o) => {
          subtitles.setOutcome(run, o);
          if (o.kind === 'done') {
            const latency = Math.round(o.finishedAt - o.job.firstAt);
            log(`translate #${o.job.id} ${Math.round(o.finishedAt - o.startedAt)}ms, from firstAt ${latency}ms`);
          } else if (o.kind === 'failed') {
            log(`translate #${o.job.id} failed: ${o.reason} ${o.message}`);
          } else {
            log(`translate #${o.job.id} skipped`);
          }
        },
        onEnded: (reason, fatal) => {
          session = null;
          subtitles.endRun();
          if (fatal) dispatch('fail', `${reason ?? '止まりました'}。「開始」でやり直します`);
          else dispatch('ended', reason ?? STOPPED_MESSAGE);
          // A target set in this window while running was held back.
          void loadTarget().then(acceptTarget);
        },
        onLog: log,
      },
    });
    dispatch('started', `「${tab.title || `タブ ${tab.tabId}`}」の音声を聞き取っています`);
  } catch (e) {
    log(`start failed: ${err(e)}`);
    subtitles.endRun();
    dispatch('startFailed', `開始できませんでした: ${err(e)}`);
    // A target set in this window while starting was held back.
    void loadTarget().then(acceptTarget);
  }
}

buttons.stop.addEventListener('click', () => {
  if (!dispatch('stop', '停止しています')) return;
  void session?.stop();
});

buttons.clear.addEventListener('click', () => {
  subtitles.clear();
  backend.clearContext();
  // The hero comes back, and the banner gives way to it.
  render();
  log('cleared');
});

buttons.close.addEventListener('click', () => {
  if (windowId !== undefined) void chrome.sidePanel.close({ windowId });
});

// Only in idle and ready: switching while translating would dispose() the engine under the job
// in progress. The new engine needs 準備, and the previous one is disposed to free PLaMo's GPU memory.
engineField.addEventListener('change', () => {
  const engine = engineInputs.find((i) => i.checked)?.value as Settings['engine'] | undefined;
  if (!engine) return;
  if (engine === backend.id) return;
  const previous = backend;
  backend = makeBackend(engine);
  if (!dispatch('engineChanged', '')) {
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
  if (!demo) void autoPrepare();
});

byId('to-latest').addEventListener('click', () => subtitles.scrollToLatest());

const copyButton = byId<HTMLButtonElement>('copy-log');
let copyReset: ReturnType<typeof setTimeout> | undefined;
copyButton.addEventListener('click', async () => {
  clearTimeout(copyReset);
  try {
    await navigator.clipboard.writeText(logView.logText);
    copyButton.textContent = 'コピーしました';
  } catch {
    copyButton.textContent = 'コピーできませんでした';
  }
  copyReset = setTimeout(() => (copyButton.textContent = 'ログをコピー'), 1500);
});
byId('clear-log').addEventListener('click', () => logView.clearLog());

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

if (!demo) void autoPrepare();
if (demo) {
  const { mountDemo } = await import('./demo');
  target ??= { tabId: 0, title: 'Weekly sync – Google Meet', windowId: windowId ?? 0 };
  mountDemo({
    subtitles,
    set: (s, text, r) => {
      state = s;
      message = text;
      Object.assign(readiness, r);
      render();
    },
  });
}
log(`Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'}, window ${windowId}`);
