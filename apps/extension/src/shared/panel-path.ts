
export const PANEL_FILE = "panel.html";

export function panelPathFor(tabId: number): string {
  return `${PANEL_FILE}?tabId=${tabId}`;
}

export function tabIdFromSearch(search: string): number | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get("tabId");
  } catch {
    return null;
  }
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
