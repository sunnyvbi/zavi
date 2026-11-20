const INTERNAL_HOST_SUFFIXES = [".onrender.com"];

export function isInternalHostingUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  let host = "";
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    host = url.trim().replace(/^[a-z]+:\/\//i, "").split("/")[0]?.toLowerCase() ?? "";
  }
  return INTERNAL_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

export function publicUrlOrNull(url: string | null): string | null {
  return url && !isInternalHostingUrl(url) ? url : null;
}
