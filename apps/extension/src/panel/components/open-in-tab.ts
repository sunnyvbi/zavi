export function openInTab(url: string) {
  return (e: { preventDefault: () => void }): void => {
    try {
      if (typeof chrome !== "undefined" && chrome.tabs?.create) {
        e.preventDefault();
        void chrome.tabs.create({ url });
      }
    } catch {
    }
  };
}
