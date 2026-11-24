// Task 3 panel: prepare, start / stop, the interim line, the decided utterances with their
// translations, and a log to copy back. Task 5 replaces it with the real UI.

import { LangDetector } from '../asr/langDetect';
import { ChromeBackend } from '../mt/chrome';
import type { Outcome } from '../mt/queue';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { loadTarget } from '../shared/target';
import { speechRecognition } from '../types/web-ai';
import { Session } from './session';

const LOCALES = ['ja-JP', 'en-US'];

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
  const backend = new ChromeBackend();
  let detector: LangDetector | null = null;
  let session: Session | null = null;
  const t0 = performance.now();

  const section = el('section', { className: 'debug' });
  const controls = el('div', { className: 'row' });
  const prepareBtn = el('button', { type: 'button', textContent: '準備' });
  const startBtn = el('button', { type: 'button', textContent: '開始', disabled: true });
  const stopBtn = el('button', { type: 'button', textContent: '停止', disabled: true });
  const noiseLabel = el('label');
  const noiseBox = el('input', { type: 'checkbox', checked: settings.noise });
  noiseLabel.append(noiseBox, ' ノイズを混ぜる');
  controls.append(prepareBtn, startBtn, stopBtn, noiseLabel);

  const status = el('div', { className: 'status', textContent: '「準備」を押してください' });
  const interim = el('div', { className: 'interim' });
  const list = el('ol', { className: 'utterances' });
  const logEl = el('textarea', { readOnly: true, rows: 10 });
  const logTools = el('div', { className: 'row' });
  const copyBtn = el('button', { type: 'button', textContent: 'ログをコピー' });
  const clearBtn = el('button', { type: 'button', textContent: '表示を消す' });
  logTools.append(copyBtn, clearBtn);
  section.append(controls, status, interim, list, logEl, logTools);
  parent.append(section);

  const log = (message: string) => {
    const line = `${new Date().toISOString().slice(11, 23)} +${Math.round(performance.now() - t0)}ms ${message}`;
    logEl.value += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };
  const rows = new Map<number, HTMLElement>();

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
    status.textContent = '準備中…';
    const SR = speechRecognition();
    const tasks = [
      SR.install({ langs: LOCALES, processLocally: true }).then((ok) => {
        if (!ok) throw new Error('install() が false を返しました');
      }),
      backend.prepare(),
      LangDetector.create().then((d) => {
        detector?.destroy();
        detector = d;
      }),
    ];
    void Promise.allSettled(tasks).then(async (results) => {
      const names = ['言語パック', 'Chrome 翻訳', '言語判定'];
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

  startBtn.addEventListener('click', async () => {
    // Disabled before any await: a second click would try to capture the tab twice.
    startBtn.disabled = true;
    const target = await loadTarget();
    if (!target || !detector) {
      status.textContent = target ? '先に「準備」を押してください' : '対象タブがありません。アイコンを押し直してください';
      startBtn.disabled = false;
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
            startBtn.disabled = false;
            noiseBox.disabled = false;
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
      startBtn.disabled = false;
    }
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
