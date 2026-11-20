
export function readWebsiteParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function writeWebsiteParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value);
  else params.delete(key);
  const qs = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
  );
}

export const WEBSITE_MODE_KEY = "zavi.websiteMode";

export function rememberWebsiteView(view: "preview" | "dashboard"): void {
  writeWebsiteParam("view", view);
  try {
    window.localStorage.setItem(WEBSITE_MODE_KEY, view);
  } catch {
    return;
  }
}
