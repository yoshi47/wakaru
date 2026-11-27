// The one visible extension page where Chrome can ask for the microphone. The side panel cannot
// show the prompt (Chromium's permission UI needs a tab); once granted here, the grant belongs to
// the extension's origin and the panel can capture without asking again.

const statusEl = document.getElementById('status')!;
const allow = document.getElementById('allow') as HTMLButtonElement;
const settings = document.getElementById('settings') as HTMLButtonElement;
const closeButton = document.getElementById('close') as HTMLButtonElement;

let lastState: PermissionState | null = null;
let busy = false;

const say = (text: string): void => {
  // role=status announces every write, even the same text: only a change is news.
  if (statusEl.textContent !== text) statusEl.textContent = text;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function permission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return null;
  }
}

async function openSettings(): Promise<void> {
  const site = encodeURIComponent(`chrome-extension://${chrome.runtime.id}/`);
  const url = `chrome://settings/content/siteDetails?site=${site}`;
  try {
    // This page is a small popup: open the settings in the last normal window, not here.
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    await chrome.tabs.create(win.id === undefined ? { url } : { url, windowId: win.id });
  } catch {
    try {
      await chrome.tabs.create({ url });
    } catch (e) {
      say(`設定を開けませんでした: ${errorText(e)}`);
    }
  }
}

async function closeWindow(): Promise<void> {
  // The popup is a window with one tab: closing the tab closes it too. window.close() may be
  // ignored for windows the page did not open with window.open.
  window.close();
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  } catch {
    // Already closed by window.close().
  }
}

async function init(): Promise<void> {
  const state = await permission();
  // A focus while the allow flow runs, or with the state unchanged, must not overwrite the
  // "今回のみ" caveat or a device error with the generic line.
  if (busy || state === lastState) return;
  lastState = state;
  if (state === 'granted') {
    settings.hidden = true;
    say(
      'この拡張機能はマイクを使用できます。この画面を閉じて、必要なら停止してから「開始」を押してください。「今回のみ」で許可した場合は、この画面を閉じると失効します。',
    );
    closeButton.hidden = false;
  } else if (state === 'denied') {
    say('マイクがブロックされています。下の「Chrome の設定を開く」から wakaru のマイクを許可してください。');
    settings.hidden = false;
  }
}

allow.addEventListener('click', async () => {
  busy = true;
  allow.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    // Keep this screen as it is: tell the side panel, then close. Only a failure needs words.
    await chrome.runtime.sendMessage({ type: 'mic-granted' }).catch(() => undefined);
    await closeWindow();
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError') {
      say('マイクが許可されませんでした。Chrome の設定で、この拡張機能のマイクを許可してください。');
      settings.hidden = false;
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      say('使用できるマイクが見つかりません。マイクが接続されているか確認してください。');
    } else {
      say(`マイクを開始できませんでした: ${errorText(e)}`);
    }
  } finally {
    lastState = await permission();
    allow.disabled = false;
    busy = false;
  }
});

settings.addEventListener('click', openSettings);

closeButton.addEventListener('click', () => void closeWindow());

// Coming back from Chrome's settings, or from the permission prompt, re-checks the state.
window.addEventListener('focus', () => void init());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void init();
});

init().catch((e: unknown) => say(`状態を確認できませんでした: ${errorText(e)}`));
