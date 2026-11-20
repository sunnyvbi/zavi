
const EVENT = "zavi:full-page-back";

export function requestFullPageBack(): boolean {
  if (typeof window === "undefined") return false;
  const ev = new Event(EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

export function onFullPageBack(isOnScreen: () => boolean, close: () => void): () => void {
  const handler = (e: Event) => {
    if (e.defaultPrevented || !isOnScreen()) return;
    e.preventDefault();
    close();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
