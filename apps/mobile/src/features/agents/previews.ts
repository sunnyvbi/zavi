

const PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" ` +
  `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; ` +
  `form-action 'none'; base-uri 'none';">`;

const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const HTTP_EQUIV = /\bhttp-equiv\s*=/i;
const HREF_OR_ACTION = /\b(href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const PING_ATTR = /\sping\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function stripNavigationVectors(html: string): string {
  return html
    .replace(META_TAG, (tag) => (HTTP_EQUIV.test(tag) ? "" : tag))
    .replace(HREF_OR_ACTION, (match, attr, dq, sq, uq) => {
      const value = (dq ?? sq ?? uq ?? "") as string;
      return value.trim().startsWith("#") ? (match as string) : `${attr}="#"`;
    })
    .replace(PING_ATTR, "");
}

export function harden(rawHtml: string): string {
  const html = stripNavigationVectors(rawHtml);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return html.replace(doctype[0], `${doctype[0]}${PREVIEW_CSP}`);
  return PREVIEW_CSP + html;
}

export type PreviewNav = "allow" | "block";

export function previewNavDecision(url: string, opts: { loaded: boolean }): PreviewNav {
  const u = url.trim().toLowerCase();
  if (u === "about:blank" || u.startsWith("about:blank#") || u === "about:srcdoc") return "allow";
  if (u.startsWith("data:")) return opts.loaded ? "block" : "allow";
  return "block";
}

const BUILDS_TOOL = "list_product_builds";

type PanelLike = { items?: unknown } | null | undefined;

export function panelCheckedProductBuilds(panel: PanelLike): boolean {
  const items = panel && Array.isArray(panel.items) ? panel.items : [];
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const tools = (item as { tools?: unknown }).tools;
    return (
      Array.isArray(tools) &&
      tools.some(
        (t) =>
          !!t &&
          typeof (t as { name?: unknown }).name === "string" &&
          (t as { name: string }).name.includes(BUILDS_TOOL),
      )
    );
  });
}

export function readShippedAppUrl(
  preview: { url?: string | null; kind?: string } | null | undefined,
): string | null {
  if (!preview || preview.kind !== "final") return null;
  const u = preview.url;
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}

export function hostLabel(url: string): string {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1] : url;
}
