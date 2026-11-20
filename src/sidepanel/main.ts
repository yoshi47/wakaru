import { loadTarget, onTargetChange, type Target } from '../shared/target';
import { mountSpike } from './spike';

const titleEl = document.getElementById('target-title')!;

function showTarget(target: Target | null): void {
  titleEl.textContent = target ? target.title || `タブ ${target.tabId}` : '（アイコンを押したタブ）';
}

document.getElementById('close')!.addEventListener('click', async () => {
  const { id } = await chrome.windows.getCurrent();
  if (id !== undefined) await chrome.sidePanel.close({ windowId: id });
});

mountSpike(document.getElementById('main')!);

// Listen before reading, so that a change made while reading is not missed.
onTargetChange(showTarget);
showTarget(await loadTarget());
