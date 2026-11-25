/** The captured audio of the target tab, played back so that the user still hears it. */
export type TabAudio = {
  /** The track to recognize. Recognizers take clones of it and stop their own clones. */
  readonly track: MediaStreamTrack;
  /** The playback AudioContext's state after starting, for the debug log. */
  readonly playbackState: AudioContextState;
  stop(): Promise<void>;
};

export type TabAudioOptions = {
  /**
   * Mix white noise at about -60 dBFS into the recognized track. In Task 1, with complete silence
   * after speech the final came late or not at all; with the noise it came on time.
   */
  noise: boolean;
  /** The capture ended without stop(): the tab was closed or navigated, or capture was taken over. */
  onEnded: () => void;
};

export class CaptureBusyError extends Error {}

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
  if (!source) throw new Error('タブの音声トラックを取得できませんでした');

  // Capturing mutes the tab: play it back through the default output.
  const ctx = new AudioContext();
  // Created after awaits, outside the click: the autoplay policy may leave it suspended.
  if (ctx.state === 'suspended') await ctx.resume();
  const input = ctx.createMediaStreamSource(stream);
  input.connect(ctx.destination);

  let track = source;
  if (opts.noise) {
    const dst = ctx.createMediaStreamDestination();
    input.connect(dst);
    addNoise(ctx, dst);
    track = dst.stream.getAudioTracks()[0] ?? source;
  }

  let stopped = false;
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
    playbackState: ctx.state,
    async stop() {
      if (stopped) return;
      stopped = true;
      chrome.tabCapture.onStatusChanged.removeListener(onStatus);
      source.removeEventListener('ended', ended);
      for (const t of stream.getTracks()) t.stop();
      if (track !== source) track.stop();
      await ctx.close();
    },
  };
}
