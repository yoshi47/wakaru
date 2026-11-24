// Task 3 / 4 panel: prepare, the translation engine, start / stop, the interim line, the decided
// utterances with their translations, and a log to copy back. Task 5 replaces it with the real UI.

import { LangDetector } from '../asr/langDetect';
import type { PrepareProgress, TranslatorBackend } from '../mt/backend';
import { ChromeBackend } from '../mt/chrome';
import { PlamoBackend } from '../mt/plamo/backend';
import type { Outcome } from '../mt/queue';
import { loadSettings, saveSettings, type Settings } from '../settings';
import type { Lang } from '../shared/lang';
import { loadTarget } from '../shared/target';
import { speechRecognition } from '../types/web-ai';
import { Session } from './session';

const LOCALES = ['ja-JP', 'en-US'];

/** Translated by the test button, with either engine. */
const SAMPLES: { text: string; from: Lang; to: Lang }[] = [
  { text: '来週のリリースについて、スケジュールを確認させてください。', from: 'ja', to: 'en' },
  { text: 'No worries, I said the API rate limit is causing the timeout errors.', from: 'en', to: 'ja' },
];
const ENGINE_LABEL = { plamo: 'PLaMo', chrome: 'Chrome 翻訳' } as const;

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  return e;
}

export async function mountDebugPanel(parent: HTMLElement): Promise<void> {
  let settings: Settings = await loadSettings();
  const t0 = performance.now();
  const log = (message: string) => {
    const line = `${new Date().toISOString().slice(11, 23)} +${Math.round(performance.now() - t0)}ms ${message}`;
    logEl.value += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };
  const makeBackend = (engine: Settings['engine']): TranslatorBackend =>
    engine === 'plamo' ? new PlamoBackend({ onLog: log }) : new ChromeBackend();
  let backend = makeBackend(settings.engine);
  let backendReady = false;
  let detector: LangDetector | null = null;
  let session: Session | null = null;

  const section = el('section', { className: 'debug' });
  const controls = el('div', { className: 'row' });
  const prepareBtn = el('button', { type: 'button', textContent: '準備' });
  const startBtn = el('button', { type: 'button', textContent: '開始', disabled: true });
  const stopBtn = el('button', { type: 'button', textContent: '停止', disabled: true });
  const noiseLabel = el('label');
  const noiseBox = el('input', { type: 'checkbox', checked: settings.noise });
  noiseLabel.append(noiseBox, ' ノイズを混ぜる');
  controls.append(prepareBtn, startBtn, stopBtn, noiseLabel);

  const engineRow = el('div', { className: 'row' });
  const engineSelect = el('select');
  for (const engine of ['plamo', 'chrome'] as const) {
    engineSelect.append(el('option', { value: engine, textContent: ENGINE_LABEL[engine], selected: engine === settings.engine }));
  }
  const sampleBtn = el('button', { type: 'button', textContent: '固定文を訳す', disabled: true });
  const engineStatus = el('span', { className: 'status' });
  engineRow.append('翻訳エンジン ', engineSelect, sampleBtn, engineStatus);

  const status = el('div', { className: 'status', textContent: '「準備」を押してください' });
  const interim = el('div', { className: 'interim' });
  const list = el('ol', { className: 'utterances' });
  const logEl = el('textarea', { readOnly: true, rows: 10 });
  const logTools = el('div', { className: 'row' });
  const copyBtn = el('button', { type: 'button', textContent: 'ログをコピー' });
  const clearBtn = el('button', { type: 'button', textContent: '表示を消す' });
  logTools.append(copyBtn, clearBtn);
  section.append(controls, engineRow, status, interim, list, logEl, logTools);
  parent.append(section);

  const rows = new Map<number, HTMLElement>();

  const showEngine = (p?: PrepareProgress) => {
    const label = ENGINE_LABEL[backend.id];
    if (p?.phase === 'download') {
      engineStatus.textContent = `${label}: モデルをダウンロード中 ${Math.floor((p.ratio ?? 0) * 100)}%（閉じると中断されます）`;
    } else if (p?.phase === 'load') {
      engineStatus.textContent = `${label}: 読み込み中`;
    } else if (backendReady) {
      engineStatus.textContent = `${label}: 準備済み${backend instanceof PlamoBackend ? `（${backend.device}）` : ''}`;
    } else {
      engineStatus.textContent = `${label}: 未準備`;
    }
  };
  showEngine();

  const showOutcome = (o: Outcome) => {
    const target = rows.get(o.job.id);
    if (!target) return;
    if (o.kind === 'done') {
      target.textContent = o.translation;
      log(`translate #${o.job.id} ${Math.round(o.finishedAt - o.startedAt)}ms, from firstAt ${Math.round(o.finishedAt - o.job.firstAt)}ms`);
    } else if (o.kind === 'failed') {
      target.textContent = `翻訳できませんでした（${o.reason === 'timeout' ? '時間切れ' : o.message}）`;
      target.classList.add('error');
      log(`translate #${o.job.id} failed: ${o.reason} ${o.message}`);
    } else {
      target.textContent = '翻訳待ちが多いため省略';
      target.classList.add('error');
      log(`translate #${o.job.id} skipped`);
    }
  };

  // Everything is started inside the click without awaiting in between: install() and
  // Translator.create() need the user gesture while their models are downloadable.
  prepareBtn.addEventListener('click', () => {
    prepareBtn.disabled = true;
    engineSelect.disabled = true;
    status.textContent = '準備中…';
    const SR = speechRecognition();
    const preparing = backend;
    const start = performance.now();
    const tasks = [
      SR.install({ langs: LOCALES, processLocally: true }).then((ok) => {
        if (!ok) throw new Error('install() が false を返しました');
      }),
      preparing.prepare(showEngine).then(() => {
        if (backend !== preparing) return;
        backendReady = true;
        log(`${preparing.id} prepared in ${Math.round(performance.now() - start)}ms`);
      }),
      LangDetector.create().then((d) => {
        detector?.destroy();
        detector = d;
      }),
    ];
    void Promise.allSettled(tasks).then(async (results) => {
      engineSelect.disabled = false;
      showEngine();
      sampleBtn.disabled = !backendReady;
      const names = ['言語パック', ENGINE_LABEL[preparing.id], '言語判定'];
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${names[i]}: ${err(r.reason)}`] : []));
      for (const l of LOCALES) {
        const availability = await SR.available({ langs: [l], processLocally: true }).catch(err);
        log(`available(${l}) = ${availability}`);
      }
      if (failed.length) {
        for (const f of failed) log(`prepare failed: ${f}`);
        status.textContent = `準備に失敗しました。もう一度押してください（${failed.join(' / ')}）`;
        prepareBtn.disabled = false;
        return;
      }
      log('prepared');
      status.textContent = '準備できました。テスト音声のタブで「開始」を押してください';
      startBtn.disabled = false;
    });
  });

  /** From the start click until the session ends: the engine stays as it is meanwhile. */
  let running = false;
  const idle = () => {
    running = false;
    startBtn.disabled = false;
    engineSelect.disabled = false;
    sampleBtn.disabled = !backendReady;
  };

  startBtn.addEventListener('click', async () => {
    // Disabled before any await: a second click would try to capture the tab twice.
    running = true;
    startBtn.disabled = true;
    engineSelect.disabled = true;
    sampleBtn.disabled = true;
    if (!backend.ready) {
      // PLaMo failed to load again after a crash, for example.
      backendReady = false;
      showEngine();
      prepareBtn.disabled = false;
      status.textContent = `${ENGINE_LABEL[backend.id]}が使えません。「準備」を押し直してください`;
      idle();
      startBtn.disabled = true;
      return;
    }
    const target = await loadTarget();
    if (!target || !detector || !backendReady) {
      status.textContent = target ? '先に「準備」を押してください' : '対象タブがありません。アイコンを押し直してください';
      idle();
      return;
    }
    settings = { ...settings, noise: noiseBox.checked };
    await saveSettings(settings);
    try {
      session = await Session.start({
        tabId: target.tabId,
        settings,
        detect: detector.detect,
        backend,
        events: {
          onInterim: (i) => {
            interim.textContent = i ? `[${i.lang.toUpperCase()}] ${i.text}` : '';
          },
          onDecision: (id, d) => {
            if (id === null) return;
            const li = el('li');
            li.append(el('div', { className: 'source', textContent: `[${d.lang?.toUpperCase()}] ${d.text}` }));
            const translation = el('div', { className: 'translation', textContent: '…' });
            li.append(translation);
            rows.set(id, translation);
            list.append(li);
            li.scrollIntoView({ block: 'end' });
          },
          onTranslation: showOutcome,
          onEnded: (reason) => {
            session = null;
            stopBtn.disabled = true;
            noiseBox.disabled = false;
            idle();
            interim.textContent = '';
            status.textContent = reason ?? '停止しました';
          },
          onLog: log,
        },
      });
      stopBtn.disabled = false;
      noiseBox.disabled = true;
      status.textContent = `認識中（${target.title || `タブ ${target.tabId}`}）`;
    } catch (e) {
      log(`start failed: ${err(e)}`);
      status.textContent = `開始できませんでした: ${err(e)}`;
      idle();
    }
  });

  // Only outside a session (the select is disabled while running): the previous engine is
  // disposed, which frees PLaMo's GPU memory, and the new one needs 準備 again.
  engineSelect.addEventListener('change', async () => {
    const engine = engineSelect.value as Settings['engine'];
    const previous = backend;
    backend = makeBackend(engine);
    backendReady = false;
    startBtn.disabled = true;
    sampleBtn.disabled = true;
    prepareBtn.disabled = false;
    showEngine();
    status.textContent = '「準備」を押してください';
    // Before saving, which could throw: PLaMo's GPU memory is freed either way.
    await previous.dispose();
    log(`${previous.id} disposed, engine=${engine}`);
    settings = { ...settings, engine };
    await saveSettings(settings);
  });

  sampleBtn.addEventListener('click', async () => {
    sampleBtn.disabled = true;
    engineSelect.disabled = true;
    const using = backend;
    for (const s of SAMPLES) {
      const start = performance.now();
      try {
        const out = await using.translate(s.text, s.from, s.to, AbortSignal.timeout(5000));
        log(`sample ${using.id} ${s.from}>${s.to} ${Math.round(performance.now() - start)}ms "${out}"`);
      } catch (e) {
        log(`sample ${using.id} ${s.from}>${s.to} failed after ${Math.round(performance.now() - start)}ms: ${err(e)}`);
      }
    }
    // The samples are not part of the meeting.
    using.clearContext();
    sampleBtn.disabled = running || backend !== using || !backendReady;
    engineSelect.disabled = running;
  });

  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    status.textContent = '停止中…';
    void session?.stop();
  });

  copyBtn.addEventListener('click', () => void navigator.clipboard.writeText(logEl.value));
  clearBtn.addEventListener('click', () => {
    logEl.value = '';
    list.replaceChildren();
    rows.clear();
  });

  log(`Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'}`);
}
