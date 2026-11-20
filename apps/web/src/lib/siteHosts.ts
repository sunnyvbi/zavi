
import { NextResponse } from "next/server";
import { isRetiredSegmentHost } from "@/lib/marketing/retiredSubdomains";

export const ZONE = "zaviagent.com";

const WEB_APP_HOSTS = new Set<string>([
  ZONE,
  `www.${ZONE}`,
  `latest.${ZONE}`,
  `staging.${ZONE}`,
  `api.${ZONE}`,
  `admin.${ZONE}`,
]);

export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  const first = host.split(",")[0]?.trim().toLowerCase() ?? "";
  const hostname = first.startsWith("[") ? first : (first.split(":")[0] ?? "");
  return hostname.replace(/\.+$/, "");
}

function configuredSiteHost(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isUnknownSiteHost(host: string | null | undefined): boolean {
  const hostname = normalizeHost(host);
  if (!hostname.endsWith(`.${ZONE}`)) return false;
  if (WEB_APP_HOSTS.has(hostname)) return false;
  if (hostname === configuredSiteHost()) return false;
  if (isRetiredSegmentHost(hostname)) return false;
  return true;
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Site not found</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #faf7f2; color: #1c1917; padding: 24px; box-sizing: border-box; }
  main { max-width: 440px; text-align: center; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; color: #57534e; margin: 0 0 24px; }
  a { color: #6d28d9; font-weight: 600; text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #fafaf9; }
    p { color: #a8a29e; }
    a { color: #a78bfa; }
  }
</style>
</head>
<body>
<main>
<h1>Site not found</h1>
<p>There is no site at this address. It may have been renamed or taken down, or the address may have a typo.</p>
<a href="https://www.${ZONE}/">Go to Zavi</a>
</main>
</body>
</html>
`;

export function siteNotFoundResponse(method: string): NextResponse {
  return new NextResponse(method === "HEAD" ? null : NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
