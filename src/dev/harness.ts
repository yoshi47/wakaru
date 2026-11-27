// `dist/dev/harness.html` (built by `pnpm build:harness` only): plays the scenarios of dev/overlap.json
// into a Session, through the real recognizers, Arbiter, Paragrapher and translation, and logs what
// comes out. For checking without a tab: capturing one needs a click on the action icon.
// Nothing goes to the speakers.

import { LangDetector } from '../asr/langDetect';
import { addNoise, type TabAudio } from '../audio/tabAudio';
import type { TranslatorBackend } from '../mt/backend';
import { ChromeBackend } from '../mt/chrome';
import { PlamoBackend } from '../mt/plamo/backend';
import { DEFAULT_SETTINGS } from '../settings';
import type { Lang } from '../shared/lang';
import { Session } from '../sidepanel/session';
import { speechRecognition } from '../types/web-ai';

type Clip = { lang: Lang; text: string; voice?: string; afterPrevEndMs?: number; atPrevRatio?: number };
type Scenario = { id: string; title: string; clips: Clip[] };

// Also works served from dist as a web page, with Chrome 翻訳: PLaMo's model is in the extension's OPFS.
const inExtension = location.protocol === 'chrome-extension:';
const audioUrl = (path: string) => (inExtension ? chrome.runtime.getURL(`harness-audio/${path}`) : `/harness-audio/${path}`);
/** Recognizers starting up before the first clip, and the last translations after it. */
const LEAD_MS = 1500;
const TAIL_MS = 6000;

const out = document.getElementById('log')!;
const status = document.getElementById('status')!;
const t0 = performance.now();
function log(message: string): void {
  out.textContent += `+${Math.round(performance.now() - t0)}ms ${message}\n`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function decode(ctx: AudioContext, path: string): Promise<AudioBuffer> {
  const bytes = await (await fetch(audioUrl(path))).arrayBuffer();
  return ctx.decodeAudioData(bytes);
}

/** Plays the scenario's clips into `dst`, each placed as dev/overlap.html does. Returns its length in ms. */
async function play(ctx: AudioContext, dst: AudioNode, s: Scenario): Promise<number> {
  const buffers = await Promise.all(s.clips.map((_, i) => decode(ctx, `${s.id}_${i + 1}.wav`)));
  const starts: number[] = [];
  s.clips.forEach((c, i) => {
    if (i === 0) return starts.push(0);
    const prevMs = buffers[i - 1]!.duration * 1000;
    starts.push(starts[i - 1]! + (c.atPrevRatio !== undefined ? prevMs * c.atPrevRatio : prevMs + (c.afterPrevEndMs ?? 0)));
  });
  const base = ctx.currentTime + 0.1;
  buffers.forEach((b, i) => {
    const node = ctx.createBufferSource();
    node.buffer = b;
    node.connect(dst);
    node.start(base + starts[i]! / 1000);
    log(`clip ${i + 1} at +${Math.round(starts[i]!)}ms for ${Math.round(b.duration * 1000)}ms: "${s.clips[i]!.text}"`);
  });
  return Math.max(...buffers.map((b, i) => starts[i]! + b.duration * 1000)) + 100;
}

async function runScenario(s: Scenario, backend: TranslatorBackend, detector: LangDetector): Promise<void> {
  log(`=== ${s.id}: ${s.title}`);
  backend.clearContext();
  const ctx = new AudioContext();
  let session: Session | undefined;
  try {
    await ctx.resume();
    const dst = ctx.createMediaStreamDestination();
    const track = dst.stream.getAudioTracks()[0]!;
    const audio: TabAudio = {
      track,
      playbackState: ctx.state,
      mic: false,
      stop: async () => {
        track.stop();
        await ctx.close();
      },
    };
    session = await Session.start({
      audio: async (o) => {
        if (o.noise) addNoise(ctx, dst);
        return audio;
      },
      settings: DEFAULT_SETTINGS,
      detect: detector.detect,
      backend,
      events: {
        onInterim: () => undefined,
        onParagraph: (jobId, u) => log(`SUBTITLE #${u.paragraph.key} (job ${jobId}) ${u.kind}: "${u.paragraph.text}"`),
        onTranslation: (o) =>
          log(
            o.kind === 'done'
              ? `TRANSLATED job ${o.job.id} (paragraph #${o.job.key}) in ${Math.round(o.finishedAt - o.startedAt)}ms: "${o.translation}"`
              : `TRANSLATION ${o.kind} job ${o.job.id} (paragraph #${o.job.key})`,
          ),
        onEnded: () => undefined,
        onLog: log,
      },
    });
    await sleep(LEAD_MS);
    const length = await play(ctx, dst, s);
    await sleep(length + TAIL_MS);
  } finally {
    // Also after a failure: a session left running would hear the next scenario too.
    if (session) await session.stop();
    else if (ctx.state !== 'closed') await ctx.close();
  }
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const ids = params.get('ids')?.split(',');
  // PLaMo loads its model and wllama from the extension: as a web page, Chrome 翻訳 only.
  const engine = inExtension && params.get('engine') !== 'chrome' ? 'plamo' : 'chrome';
  status.textContent = 'running';
  // Started within the click, before any await: install() and Translator.create() may need it.
  const installing = speechRecognition().install({ langs: ['ja-JP', 'en-US'], processLocally: true });
  const detecting = LangDetector.create();
  const backend: TranslatorBackend = engine === 'chrome' ? new ChromeBackend() : new PlamoBackend({ onLog: log });
  const preparing = backend.prepare();
  if (!(await installing)) throw new Error('install() が false を返しました');
  const [detector] = await Promise.all([detecting, preparing]);
  const all = (await (await fetch(audioUrl('overlap.json'))).json()) as Scenario[];
  const scenarios = ids ? all.filter((s) => ids.includes(s.id)) : all;
  log(`engine=${engine} fast=${backend.fast} scenarios=${scenarios.map((s) => s.id).join(',')}`);
  for (const s of scenarios) await runScenario(s, backend, detector);
  await backend.dispose();
  status.textContent = 'DONE';
}

// A click: the AudioContext may not start without one.
document.getElementById('run')!.addEventListener('click', () => {
  run().catch((e: unknown) => {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    status.textContent = 'FAILED';
  });
});
