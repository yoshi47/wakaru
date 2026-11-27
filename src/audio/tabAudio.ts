/** The captured audio of the target tab, played back so that the user still hears it. */
export type TabAudio = {
  /** The track to recognize. Recognizers take clones of it and stop their own clones. */
  readonly track: MediaStreamTrack;
  /** The playback AudioContext's state after starting, for the debug log. */
  readonly playbackState: AudioContextState;
  /** Whether the microphone is mixed into `track`. */
  readonly mic: boolean;
  /** Why the microphone is not mixed, when it was asked for. The tab audio still runs. */
  readonly micError?: string;
  stop(): Promise<void>;
};

export type TabAudioOptions = {
  /**
   * Mix white noise at about -60 dBFS into the recognized track. In Task 1, with complete silence
   * after speech the final came late or not at all; with the noise it came on time.
   */
  noise: boolean;
  /** Mix the default microphone into the recognized track. */
  mic: boolean;
  /** The microphone ended by itself: the device was removed. The tab audio keeps going. */
  onMicEnded?: () => void;
  /** The capture ended without stop(): the tab was closed or navigated, or capture was taken over. */
  onEnded: () => void;
};

export class CaptureBusyError extends Error {}

/** Long enough for a slow device, short enough not to leave the tab captured on a stuck prompt. */
const MIC_TIMEOUT_MS = 5000;

/** White noise at about -60 dBFS into `dst`, for as long as `ctx` runs (see TabAudioOptions.noise). */
export function addNoise(ctx: AudioContext, dst: AudioNode): void {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.001;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  noise.connect(dst);
  noise.start();
}

function micErrorText(e: unknown): string {
  if (e instanceof Error && e.message === 'マイクの応答がありません') {
    return 'マイクの応答がありません（許可の画面が出ていない可能性があります）';
  }
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'マイクの使用が許可されていません';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '使用できるマイクが見つかりません';
  return `マイクを開始できませんでした: ${e instanceof Error ? e.message : String(e)}`;
}

/** A helper, not a comparison at the call site: TS narrows a track's readyState to live after it is acquired. */
const hasEnded = (track: MediaStreamTrack): boolean => track.readyState === 'ended';

export async function startTabAudio(tabId: number, opts: TabAudioOptions): Promise<TabAudio> {
  const captured = await chrome.tabCapture.getCapturedTabs();
  if (captured.some((c) => c.tabId === tabId && (c.status === 'active' || c.status === 'pending'))) {
    throw new CaptureBusyError('このタブはすでにキャプチャされています');
  }

  const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } },
  } as unknown as MediaStreamConstraints);
  const source = stream.getAudioTracks()[0];
  if (!source) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error('タブの音声トラックを取得できませんでした');
  }

  // The tab may close or navigate while the microphone is being set up. Listen from here, but
  // only hand the end to the caller once it has the TabAudio: before that, the start fails.
  let endedEarly = false;
  const earlyEnded = () => {
    endedEarly = true;
  };
  const earlyStatus = (info: chrome.tabCapture.CaptureInfo) => {
    if (info.tabId === tabId && (info.status === 'stopped' || info.status === 'error')) endedEarly = true;
  };
  source.addEventListener('ended', earlyEnded);
  chrome.tabCapture.onStatusChanged.addListener(earlyStatus);

  let ctx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let track = source;
  let micError: string | undefined;
  // Set as soon as this start is abandoned or stopped: a late microphone `ended` event must not
  // reach the next run, which has its own session.
  let stopped = false;
  const abandon = async (): Promise<void> => {
    stopped = true;
    source.removeEventListener('ended', earlyEnded);
    chrome.tabCapture.onStatusChanged.removeListener(earlyStatus);
    for (const t of stream.getTracks()) t.stop();
    for (const t of micStream?.getTracks() ?? []) t.stop();
    if (track !== source) track.stop();
    await ctx?.close().catch(() => undefined);
  };

  try {
    ctx = new AudioContext();
    // Created after awaits, outside the click: the autoplay policy may leave it suspended.
    if (ctx.state === 'suspended') await ctx.resume();
    // With a mix, a suspended context would make the only recognized track silent.
    if (ctx.state !== 'running') throw new Error(`音声の再生を開始できませんでした（${ctx.state}）`);
    const input = ctx.createMediaStreamSource(stream);
    input.connect(ctx.destination);

    if (opts.mic || opts.noise) {
      const dst = ctx.createMediaStreamDestination();
      input.connect(dst);
      if (opts.noise) addNoise(ctx, dst);
      if (opts.mic) {
        let timedOut = false;
        const pending = navigator.mediaDevices.getUserMedia({
          // Why the microphone is not played back: the user would hear themselves, and the
          // speaker output would feed back into the microphone.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        // A stream that arrives after the timeout must not stay live: it would leave the
        // browser's microphone indicator on with nothing listening to it.
        pending.then(
          (s) => {
            if (timedOut) for (const t of s.getTracks()) t.stop();
          },
          () => undefined,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          micStream = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('マイクの応答がありません'));
              }, MIC_TIMEOUT_MS);
            }),
          ]);
        } catch (e) {
          // A microphone that cannot start must not cost the user the meeting's transcription.
          micError = micErrorText(e);
          micStream = null;
        } finally {
          clearTimeout(timer);
        }
        if (micStream) {
          const micSource = ctx.createMediaStreamSource(micStream);
          micSource.connect(dst);
          micStream
            .getAudioTracks()[0]
            ?.addEventListener(
              'ended',
              () => {
                if (!stopped) opts.onMicEnded?.();
              },
              { once: true },
            );
        }
      }
      track = dst.stream.getAudioTracks()[0] ?? source;
    }
    if (endedEarly || hasEnded(source)) {
      throw new Error('キャプチャ対象のタブが終了しました。アイコンを押し直してください');
    }
  } catch (e) {
    await abandon();
    throw e;
  }

  source.removeEventListener('ended', earlyEnded);
  chrome.tabCapture.onStatusChanged.removeListener(earlyStatus);
  if (endedEarly || hasEnded(source)) {
    await abandon();
    throw new Error('キャプチャ対象のタブが終了しました。アイコンを押し直してください');
  }

  // No await between the check above and the listeners below: no end can slip between them.
  const context = ctx!;
  const mic = micStream;
  const ended = () => {
    if (stopped) return;
    opts.onEnded();
  };
  const onStatus = (info: chrome.tabCapture.CaptureInfo) => {
    if (info.tabId === tabId && (info.status === 'stopped' || info.status === 'error')) ended();
  };
  source.addEventListener('ended', ended);
  chrome.tabCapture.onStatusChanged.addListener(onStatus);

  return {
    track,
    playbackState: context.state,
    mic: mic !== null,
    ...(micError ? { micError } : {}),
    async stop() {
      if (stopped) return;
      stopped = true;
      chrome.tabCapture.onStatusChanged.removeListener(onStatus);
      source.removeEventListener('ended', ended);
      for (const t of stream.getTracks()) t.stop();
      for (const t of mic?.getTracks() ?? []) t.stop();
      if (track !== source) track.stop();
      await context.close();
    },
  };
}
