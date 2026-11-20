
const PLATFORM_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "linktr.ee",
  "etsy.com",
  "apps.apple.com",
  "play.google.com",
];

export function isPlatformHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`))) return true;
  const parts = h.split(".");
  const twoPartTld =
    parts.length >= 3 &&
    ["co", "com", "org", "gov", "ac", "net", "edu"].includes(parts[parts.length - 2]) &&
    parts[parts.length - 1].length === 2;
  return parts[parts.length - (twoPartTld ? 3 : 2)] === "amazon";
}

export function companyNameFromHost(host: string): string {
  if (isPlatformHost(host)) return "";
  const label = host.split(".")[0] ?? "";
  if (!label) return "";
  return label.charAt(0).toUpperCase() + label.slice(1);
}
