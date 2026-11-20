/** The tab whose audio is captured: the one the user clicked the action icon on. */
export type Target = { tabId: number; title: string; windowId: number };

export async function loadTarget(): Promise<Target | null> {
  const { target } = await chrome.storage.session.get('target');
  return (target as Target | undefined) ?? null;
}

export function onTargetChange(listener: (target: Target | null) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && 'target' in changes) {
      listener((changes.target?.newValue as Target | undefined) ?? null);
    }
  });
}
