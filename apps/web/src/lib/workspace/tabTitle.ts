
let baseTitle: string | null = null;
const counted = new Set<string>();
let listening = false;

function restore() {
  if (typeof document === "undefined" || document.hidden) return;
  if (baseTitle !== null) document.title = baseTitle;
  baseTitle = null;
  counted.clear();
}

export function bumpTabTitle(key: string, label: string): void {
  if (typeof document === "undefined" || !document.hidden) return;
  if (!listening) {
    document.addEventListener("visibilitychange", restore);
    listening = true;
  }
  if (counted.has(key)) return;
  counted.add(key);
  if (baseTitle === null) baseTitle = document.title;
  document.title = `(${counted.size}) ${label} · Zavi`;
}

export function resetTabTitle(): void {
  if (typeof document !== "undefined" && baseTitle !== null) document.title = baseTitle;
  baseTitle = null;
  counted.clear();
}
