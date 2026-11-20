const SITE_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export function workspaceLogoUrl(website: string | null | undefined): string | null {
  const raw = (website ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  const host = (m ? m[1] : raw.split(/\s+/)[0]).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  return SITE_RE.test(host) ? `https://${host}/favicon.ico` : null;
}
