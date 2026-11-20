// Task 1 spike: buttons that check the plan's risky assumptions inside the extension's side
// panel. Temporary: replaced by the real panel from Task 3 on. Every result goes to the log,
// which the user copies back.

import { loadTarget } from '../shared/target';
import {
  languageDetectorApi,
  speechRecognition,
  translatorApi,
  type Recognition,
} from '../types/web-ai';

const MODEL = {
  name: 'plamo-3-translate-0.8b-Q4_K_M.gguf',
  url: 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/e10c327b7a7ce84ffc427cb4b09360b781429fda/plamo-3-translate-0.8b-Q4_K_M.gguf',
  bytes: 573126848,
};

// Strings whose LanguageDetector results were measured on Chrome Beta 159.
const DETECT_SAMPLES = [
  'Bakari Masta Auto de Surah unique',
  'Bakari Masta Auto de Surah conico YouTube',
  'Schedu schedule',
  'Ok Google',
  'Okay',
  'Yeah',
  'Sure',
  'Sure we are planning to ship the new feature on Wednesday',
  'Can you share the dashboard Link in slack after this meeting',
];

const TRANSLATE_SAMPLES: { from: 'ja' | 'en'; to: 'ja' | 'en'; text: string }[] = [
  { from: 'ja', to: 'en', text: 'その件は一旦持ち帰って、チーム内で検討させてください。' },
  { from: 'en', to: 'ja', text: "That makes sense. Let's circle back on this next week." },
  { from: 'ja', to: 'en', text: 'なるほど、それならキャッシュを入れれば解決しそうですね。' },
  { from: 'en', to: 'ja', text: 'No worries. I said the API rate limit is causing the timeout errors.' },
];

let logEl: HTMLTextAreaElement;
const t0 = performance.now();

function log(item: string, message: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} +${Math.round(performance.now() - t0)}ms [${item}] ${message}`;
  logEl.value += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const err = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function button(parent: HTMLElement, label: string, onClick: () => Promise<void> | void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => {
    Promise.resolve()
      .then(onClick)
      .catch((e) => log('error', err(e)));
  });
  parent.append(b);
  return b;
}

// ---- 1, 2: tab audio ----

let stream: MediaStream | null = null;
let playback: AudioContext | null = null;

async function capture(): Promise<void> {
  const target = await loadTarget();
  if (!target) throw new Error('対象タブがない。アイコンを押してから開く');
  const start = performance.now();
  try {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
    log('1', `getMediaStreamId OK (${Math.round(performance.now() - start)}ms) tab=${target.tabId} "${target.title}"`);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } },
    } as unknown as MediaStreamConstraints);
    const track = stream.getAudioTracks()[0];
    log('1', `getUserMedia OK: track=${track?.label ?? '(none)'} state=${track?.readyState}`);
    track?.addEventListener('ended', () => log('1', 'track ended'));
    log('2', 'いまタブの音は止まっているはず。「2. 音を流し直す」を押して聞こえるようになるか確かめる');
  } catch (e) {
    log('1', `FAILED: ${err(e)}`);
  }
}

function replay(): void {
  if (!stream) throw new Error('先に 1 を押す');
  playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);
  log('2', `AudioContext で再生し直した (state=${playback.state})。タブの音が聞こえるか確かめる`);
}

// ---- 3, 4: language packs, Translator, LanguageDetector in one click ----

async function prepareAll(): Promise<void> {
  const SR = speechRecognition();
  const langs = ['ja-JP', 'en-US'];
  for (const l of langs) log('3', `available(${l}) = ${await SR.available({ langs: [l], processLocally: true })}`);
  const needInstall = [];
  for (const l of langs) if ((await SR.available({ langs: [l], processLocally: true })) !== 'available') needInstall.push(l);
  if (needInstall.length) {
    const start = performance.now();
    try {
      const ok = await SR.install({ langs: needInstall, processLocally: true });
      log('3', `install(${needInstall.join(',')}) = ${ok} (${Math.round(performance.now() - start)}ms)`);
    } catch (e) {
      log('3', `install FAILED: ${err(e)}`);
    }
  } else {
    log('3', 'install 不要（両方 available）');
  }
  for (const l of langs) log('3', `after: available(${l}) = ${await SR.available({ langs: [l], processLocally: true })}`);

  // 4: still inside the same click, after the awaits above.
  const T = translatorApi();
  for (const [s, t] of [['ja', 'en'], ['en', 'ja']] as const) {
    const before = await T.availability({ sourceLanguage: s, targetLanguage: t });
    try {
      const tr = await T.create({ sourceLanguage: s, targetLanguage: t });
      log('4', `Translator ${s}>${t}: ${before} -> create OK`);
      tr.destroy();
    } catch (e) {
      log('4', `Translator ${s}>${t}: ${before} -> create FAILED: ${err(e)}`);
    }
  }
  const LD = languageDetectorApi();
  const before = await LD.availability();
  try {
    const d = await LD.create();
    log('4', `LanguageDetector: ${before} -> create OK`);
    d.destroy();
  } catch (e) {
    log('4', `LanguageDetector: ${before} -> create FAILED: ${err(e)}`);
  }
}

async function detectSamples(): Promise<void> {
  const d = await languageDetectorApi().create();
  for (const s of DETECT_SAMPLES) {
    const r = (await d.detect(s)).slice(0, 3).map((x) => `${x.detectedLanguage}:${x.confidence.toFixed(2)}`);
    log('LD', `"${s}" -> ${r.join(' ')}`);
  }
  d.destroy();
}

// ---- 5, 6: two on-device recognizers on the tab audio ----

let recognizers: Recognition[] = [];
let running = false;
let noiseCtx: AudioContext | null = null;

function noisyTrack(source: MediaStream): MediaStreamTrack {
  noiseCtx = new AudioContext({ sampleRate: 16000 });
  const dst = noiseCtx.createMediaStreamDestination();
  noiseCtx.createMediaStreamSource(source).connect(dst);
  const buffer = noiseCtx.createBuffer(1, noiseCtx.sampleRate * 2, noiseCtx.sampleRate);
  const data = buffer.getChannelData(0);
  // White noise at about -60 dBFS (amplitude 0.001).
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.001;
  const noise = noiseCtx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  noise.connect(dst);
  noise.start();
  return dst.stream.getAudioTracks()[0]!;
}

function startRecognition(withNoise: boolean): void {
  if (!stream) throw new Error('先に 1 を押す');
  if (running) throw new Error('すでに動いている');
  const SR = speechRecognition();
  const item = withNoise ? '6' : '5';
  log(item, `'processLocally' in prototype = ${'processLocally' in SR.prototype}`);
  const base = withNoise ? noisyTrack(stream) : stream.getAudioTracks()[0]!;
  running = true;
  recognizers = (['ja-JP', 'en-US'] as const).map((lang, i) => {
    const r = new SR();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.processLocally = true;
    log(item, `${lang}: processLocally read back = ${r.processLocally}`);
    const track = i === 0 ? base : base.clone();
    let lastInterimLog = 0;
    r.onstart = () => log(item, `${lang} start`);
    r.onerror = (e) => log(item, `${lang} ERROR ${e.error} ${e.message}`);
    r.onresult = (e) => {
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k]!;
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) {
          log(item, `${lang} FINAL "${text}"`);
        } else if (performance.now() - lastInterimLog > 700) {
          lastInterimLog = performance.now();
          log(item, `${lang} interim "${text}"`);
        }
      }
    };
    r.onend = () => {
      log(item, `${lang} end`);
      if (running) {
        try {
          r.start(track);
        } catch (e) {
          log(item, `${lang} restart FAILED: ${err(e)}`);
        }
      }
    };
    r.start(track);
    return r;
  });
  log(item, 'テストタブで「再生」を押す。全部流れたら「認識を止める」');
}

function stopRecognition(): void {
  running = false;
  for (const r of recognizers) r.abort();
  recognizers = [];
  void noiseCtx?.close();
  noiseCtx = null;
  log('5/6', 'stopped');
}

// ---- 8: model download into OPFS ----

async function downloadModel(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    const f = await (await root.getFileHandle(MODEL.name)).getFile();
    if (f.size === MODEL.bytes) {
      log('8', `既にある (${f.size} bytes)`);
      return;
    }
  } catch {
    // not downloaded yet
  }
  const start = performance.now();
  const res = await fetch(MODEL.url);
  log('8', `fetch: HTTP ${res.status} final url host=${new URL(res.url).host}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const handle = await root.getFileHandle(MODEL.name, { create: true });
  const writable = await handle.createWritable();
  let received = 0;
  let reported = 0;
  const progress = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.length;
      if (received - reported > 64 << 20) {
        reported = received;
        log('8', `${Math.round((received / MODEL.bytes) * 100)}% (${Math.round(received / 1e6)}MB)`);
      }
      controller.enqueue(chunk);
    },
  });
  await res.body.pipeThrough(progress).pipeTo(writable);
  const size = (await handle.getFile()).size;
  log('8', `done: ${size} bytes (expected ${MODEL.bytes}) in ${Math.round((performance.now() - start) / 1000)}s`);
  const est = await navigator.storage.estimate();
  log('8', `storage usage=${Math.round((est.usage ?? 0) / 1e6)}MB quota=${Math.round((est.quota ?? 0) / 1e9)}GB persisted=${await navigator.storage.persisted()}`);
}

// ---- 7: wllama on WebGPU ----

type WllamaLike = {
  loadModel(files: Blob[], options: Record<string, unknown>): Promise<void>;
  createCompletion(options: Record<string, unknown>): Promise<{ choices?: { text?: string }[] }>;
  getNumThreads(): number;
  exit(): Promise<void>;
};

const TAG = '<|plamo:tag|>';
const plamoPrompt = (text: string, from: string, to: string) =>
  `${TAG}dataset<|plamo:msg|>translation${TAG}input<|plamo:key|>lang<|plamo:val|>${from}<|plamo:msg|>${text}` +
  `${TAG}output<|plamo:key|>lang<|plamo:val|>${to}<|plamo:msg|>`;

async function wllamaTest(): Promise<void> {
  let mod: { Wllama: new (paths: Record<string, string>, options: Record<string, unknown>) => WllamaLike };
  try {
    mod = await import(/* @vite-ignore */ chrome.runtime.getURL('vendor/wllama/wllama.js'));
  } catch (e) {
    log('7', `wllama.js を読み込めない（public/vendor/wllama/ が未配置？）: ${err(e)}`);
    return;
  }
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(MODEL.name)).getFile();
  const lines: string[] = [];
  const keep = (...a: unknown[]) => lines.push(a.join(' '));
  const w = new mod.Wllama(
    { default: chrome.runtime.getURL('vendor/wllama/wllama.wasm') },
    { logger: { debug: keep, log: keep, info: keep, warn: keep, error: keep } },
  );
  const start = performance.now();
  await w.loadModel([file], { n_ctx: 4096, n_gpu_layers: 999, cache_ram_mib: 0 });
  log('7', `loadModel OK (${Math.round(performance.now() - start)}ms) threads=${w.getNumThreads()}`);
  for (const l of lines.filter((l) => /ggml_webgpu: adapter_info|offloaded/.test(l))) log('7', l.slice(0, 160));
  for (const s of TRANSLATE_SAMPLES) {
    const t = performance.now();
    const r = await w.createCompletion({
      prompt: plamoPrompt(s.text, s.from, s.to),
      max_tokens: 128,
      temperature: 0,
      stop: [TAG],
    });
    log('7', `${s.from}>${s.to} ${Math.round(performance.now() - t)}ms "${(r.choices?.[0]?.text ?? '').trim()}"`);
  }
  await w.exit();
}

// ---- UI ----

export function mountSpike(parent: HTMLElement): void {
  const section = document.createElement('section');
  section.className = 'spike';
  section.innerHTML = '<h2>Task 1 スパイク</h2>';
  const row = (label: string) => {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<span class="step">${label}</span>`;
    section.append(div);
    return div;
  };

  button(row('1・2'), '1. タブ音声を取る', capture);
  button(section.lastElementChild as HTMLElement, '2. 音を流し直す', replay);
  button(row('3・4'), '言語パック + 翻訳モデル + 言語判定（1クリック）', prepareAll);
  button(row('LD'), 'LanguageDetector の値', detectSamples);
  const rec = row('5・6');
  button(rec, '5. 認識を始める', () => startRecognition(false));
  button(rec, '6. ノイズありで始める', () => startRecognition(true));
  button(rec, '認識を止める', stopRecognition);
  button(row('8'), '8. PLaMo モデルをダウンロード', downloadModel);
  button(row('7'), '7. wllama で翻訳', wllamaTest);

  logEl = document.createElement('textarea');
  logEl.readOnly = true;
  logEl.rows = 16;
  section.append(logEl);
  const tools = row('ログ');
  button(tools, 'コピー', async () => {
    await navigator.clipboard.writeText(logEl.value);
    log('log', 'コピーした');
  });
  button(tools, '消す', () => {
    logEl.value = '';
  });
  parent.append(section);
  log('info', `Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'} / WebGPU=${'gpu' in navigator}`);
}
