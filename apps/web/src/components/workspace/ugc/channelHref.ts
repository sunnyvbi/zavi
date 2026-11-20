export function channelHref(current: string, slug: string, extra: Record<string, string> = {}): string {
  const url = new URL(current, "https://workspace.local");
  url.search = "";
  url.searchParams.set("tab", "channels");
  url.searchParams.set("channel", slug);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}`;
}
