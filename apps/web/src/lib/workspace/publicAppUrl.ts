const INTERNAL_HOST_SUFFIXES = [".onrender.com"];

export function hostOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isInternalHostUrl(url: string | null | undefined): boolean {
  const host = hostOfUrl(url);
  if (!host) return false;
  const bare = host.split(":")[0];
  return INTERNAL_HOST_SUFFIXES.some((s) => bare === s.slice(1) || bare.endsWith(s));
}

export function publicAppUrl(url: string | null | undefined): string | null {
  return url && !isInternalHostUrl(url) ? url : null;
}

export function routeLabel(url: string | null | undefined): string {
  if (!url) return "Home";
  try {
    const u = new URL(url);
    const path = `${u.pathname || "/"}${u.search || ""}`;
    return path === "/" ? "Home" : path;
  } catch {
    return "Home";
  }
}
