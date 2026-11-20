
const ZOOM_MEET_TEAMS =
  /^(https?:\/\/)?([a-z0-9-]+\.)*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\//i;

export function isSupportedMeetingUrl(url: string): boolean {
  return ZOOM_MEET_TEAMS.test(url.trim());
}

export function canonicalizeMeetingUrl(url: string): string {
  const trimmed = url.trim();
  if (/meet\.google\.com/i.test(trimmed)) {
    return trimmed.split(/[?#]/)[0];
  }
  return trimmed;
}

export function sameMeetingLink(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (url: string | null | undefined): string | null => {
    if (!url || !url.trim()) return null;
    const bare = canonicalizeMeetingUrl(url).replace(/^https?:\/\//i, "");
    const cut = bare.search(/[/?#]/);
    const host = cut < 0 ? bare : bare.slice(0, cut);
    const rest = cut < 0 ? "" : bare.slice(cut);
    return host.toLowerCase() + rest.replace(/\/+(?=$|[?#])/, "");
  };
  const ka = key(a);
  return ka !== null && ka === key(b);
}
