import { NextResponse } from "next/server";

export const SITE_BASE_DOMAIN = "zaviagent.com";

const SITE_LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}(?:-[0-9a-f]{6})?(?:-[a-z0-9]{1,10})?$/;

export function isUnpublishedSiteHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(",")[0]?.split(":")[0]?.trim().toLowerCase() ?? "";
  const suffix = `.${SITE_BASE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length <= 63 && SITE_LABEL_RE.test(label);
}

export const UNPUBLISHED_SITE_MESSAGE =
  "This site hasn't been published yet. Publish it from Zavi to see it here.";

const UNPUBLISHED_SITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="15">
<title>Not published yet</title>
<style>
html,body{height:100%;margin:0}
body{background:#1c1c1c;color:#a1a1aa;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:0 16px;box-sizing:border-box;text-align:center}
main{display:flex;flex-direction:column;align-items:center;gap:28px;max-width:640px}
svg{width:88px;height:88px}
p{margin:0;font-size:17px;line-height:1.5;letter-spacing:.01em}
</style>
</head>
<body>
<main>
<svg viewBox="0 0 88 88" aria-hidden="true"><rect width="88" height="88" rx="24" fill="#a1a1aa"/><path d="M26 28h36v8L38 60h24v8H26v-8l24-24H26z" fill="#1c1c1c"/></svg>
<p>${UNPUBLISHED_SITE_MESSAGE}</p>
</main>
</body>
</html>`;

export function unpublishedSiteResponse(method = "GET"): NextResponse {
  return new NextResponse(method.toUpperCase() === "HEAD" ? null : UNPUBLISHED_SITE_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
