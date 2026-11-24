// download() and removeStaleParts() are ported from tanakh/plamo-translate-desktop
// (Apache-2.0 OR MIT), extension/engine.js at 3d69a116c45a8116159f1a405311a59039ec4b95.

/** PLaMo 3 Translate 0.8B, pinned to one revision of the file. */
export const MODEL = {
  repo: 'pfnet/plamo-3-translate-0.8b-GGUF',
  revision: 'e10c327b7a7ce84ffc427cb4b09360b781429fda',
  file: 'plamo-3-translate-0.8b-Q4_K_M.gguf',
  bytes: 573_126_848,
} as const;

const modelUrl = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`;
/** Named for its revision, so that a part of another revision is never continued. */
const partName = `${MODEL.file}.${MODEL.revision.slice(0, 12)}.part`;
/** OPFS keeps what a writable stream wrote only once it is closed. */
const CLOSE_EVERY = 64 << 20;
const REPORT_EVERY = 8 << 20;
/** Shared by every document of the extension: two panels must not write the same part. */
const LOCK = 'wakaru-model-download';

// The OPFS root, where Task 1 saved the model. Why not tanakh's `models/` directory: the file
// already there would be downloaded again.
const modelDir = () => navigator.storage.getDirectory();

/** The downloaded model, or null. Only a complete download gets the file's name. */
export async function modelFile(): Promise<File | null> {
  try {
    const file = await (await (await modelDir()).getFileHandle(MODEL.file)).getFile();
    return file.size === MODEL.bytes ? file : null;
  } catch {
    return null;
  }
}

/**
 * Removes the partial downloads other than `keep` (other revisions), and the swap files a write
 * left when its document closed (`.crswap`, which OPFS never uses again). No write may be running.
 */
async function removeStaleParts(dir: FileSystemDirectoryHandle, keep: string | null): Promise<void> {
  const stale: string[] = [];
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (name !== keep && name.startsWith(`${MODEL.file}.`) && (name.endsWith('.part') || name.endsWith('.crswap'))) {
      stale.push(name);
    }
  }
  for (const name of stale) await dir.removeEntry(name).catch(() => undefined);
}

type Movable = FileSystemFileHandle & { move(dir: FileSystemDirectoryHandle, name: string): Promise<void> };

/**
 * Downloads the model into OPFS, continuing a partial download with a Range request, and returns
 * it. Closing the stream every CLOSE_EVERY bytes keeps what arrived if the panel closes: at most
 * that much is fetched again. The size is the only check (see the plan for why not SHA-256).
 */
export async function downloadModel(opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {}): Promise<File> {
  const { onProgress, signal } = opts;
  // Without persistence the browser may evict the 573MB when space runs short.
  navigator.storage.persist?.().catch(() => undefined);
  return navigator.locks.request(LOCK, { signal }, async () => {
    // Another document may have finished it while this one waited for the lock.
    const done = await modelFile();
    if (done) return done;

    const dir = await modelDir();
    await removeStaleParts(dir, partName);
    let part = await dir.getFileHandle(partName, { create: true });
    let received = (await part.getFile()).size;
    if (received > MODEL.bytes) {
      // Not a beginning of this file: start over.
      await dir.removeEntry(partName);
      part = await dir.getFileHandle(partName, { create: true });
      received = 0;
    }

    let writable: FileSystemWritableFileStream | null = null;
    try {
      if (received < MODEL.bytes) {
        const response = await fetch(modelUrl, {
          signal,
          ...(received ? { headers: { Range: `bytes=${received}-` } } : {}),
        });
        if (!response.ok || !response.body) throw new Error(`モデルを取得できません（HTTP ${response.status}）`);
        // A range from elsewhere than the end of the part would corrupt it: start over then.
        // Content-Range is hidden from CORS reads unless the CDN exposes it; Content-Length is not.
        const range = response.headers.get('content-range');
        const resume =
          response.status === 206 &&
          (range !== null
            ? range.startsWith(`bytes ${received}-`)
            : Number(response.headers.get('content-length')) === MODEL.bytes - received);
        if (response.status === 206 && !resume) {
          await response.body.cancel();
          await dir.removeEntry(partName);
          throw new Error('サーバーが別の範囲を返しました。もう一度試してください');
        }
        // A 200 sends the whole file: the part is written again from the start.
        if (!resume) received = 0;
        writable = await part.createWritable({ keepExistingData: resume });
        await writable.seek(received);
        onProgress?.(received / MODEL.bytes);
        let reported = received;
        let unclosed = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.length;
          unclosed += value.length;
          if (unclosed >= CLOSE_EVERY) {
            await writable.close();
            writable = await part.createWritable({ keepExistingData: true });
            await writable.seek(received);
            unclosed = 0;
          }
          if (received - reported >= REPORT_EVERY) {
            reported = received;
            onProgress?.(received / MODEL.bytes);
          }
        }
        await writable.close();
        writable = null;
      }
      if (received !== MODEL.bytes) {
        throw new Error(`モデルのサイズが違います（${received} / ${MODEL.bytes} バイト）`);
      }
      await dir.removeEntry(MODEL.file).catch(() => undefined);
      await (part as Movable).move(dir, MODEL.file);
      onProgress?.(1);
    } catch (e) {
      // Keeps what arrived for the next try.
      await writable?.close().catch(() => undefined);
      throw e;
    }
    const file = await modelFile();
    if (!file) throw new Error('ダウンロードしたモデルを開けません');
    return file;
  });
}
