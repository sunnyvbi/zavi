
export const WWW_ORIGIN = "https://www.zaviagent.com";

const RETIRED_SEGMENT_SUBDOMAINS = new Set([
  "marketplaces",
  "solo",
  "growth",
  "saas",
  "startup",
]);

export function isRetiredSegmentHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = (host.split(",")[0]?.split(":")[0]?.trim().toLowerCase() ?? "").replace(/\.+$/, "");
  const firstLabel = hostname.split(".")[0] ?? "";
  return RETIRED_SEGMENT_SUBDOMAINS.has(firstLabel) && hostname === `${firstLabel}.zaviagent.com`;
}
