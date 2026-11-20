import type { Target } from './shared/target';

// Why not setPanelBehavior({ openPanelOnActionClick: true }): opening the panel that way grants
// no activeTab, so the panel could not call chrome.tabCapture (Chromium issue 336592430).
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // sidePanel.open() must run within the user gesture, so it is called before any await.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  const target: Target = { tabId: tab.id, title: tab.title ?? '', windowId: tab.windowId };
  chrome.storage.session.set({ target }).catch(console.error);
});
