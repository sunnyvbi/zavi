export const RETURN_REFETCH_GAP_MS = 1000;
export const CHANNEL_SETTINGS_CHANGED_EVENT = "zavi:channel-settings-changed";

export function announceChannelSettingsChanged(): void {
  window.dispatchEvent(new Event(CHANNEL_SETTINGS_CHANGED_EVENT));
}

export function onTabReturn(handler: () => void, gapMs: number = RETURN_REFETCH_GAP_MS): () => void {
  let lastReturnAt = Number.NEGATIVE_INFINITY;
  const onReturn = () => {
    const now = Date.now();
    if (now - lastReturnAt < gapMs) return;
    lastReturnAt = now;
    handler();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") onReturn();
  };
  window.addEventListener("focus", onReturn);
  window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, onReturn);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("focus", onReturn);
    window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, onReturn);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
