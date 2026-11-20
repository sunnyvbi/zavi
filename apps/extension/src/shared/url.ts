
export function stripUrlQuery(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.search = "";
  u.hash = "";
  u.username = "";
  u.password = "";
  return u.toString();
}
