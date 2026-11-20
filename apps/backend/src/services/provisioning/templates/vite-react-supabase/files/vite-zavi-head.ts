
export type ZaviHead = {
  name?: string;
  url?: string;
  image?: string;
};

const attr = (value: string) =>
  value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const text = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function metaContent(html: string, key: "name" | "property", value: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const keyMatch = new RegExp(`\\b${key}\\s*=\\s*["']${value}["']`, "i").test(tag);
    if (!keyMatch) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    return (content?.[1] ?? content?.[2] ?? "").trim();
  }
  return null;
}

export function zaviHeadTags(html: string, head: ZaviHead): string {
  const close = html.search(/<\/head>/i);
  if (close < 0) return html;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let title = (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim();
  const name = (head.name ?? "").trim();
  const add: string[] = [];
  if (!title || title === "New site") {
    title = name ? text(name) : title;
    if (title && !titleMatch) add.push(`<title>${title}</title>`);
  }
  const description = metaContent(html, "name", "description");
  const url = (head.url ?? "").trim();
  const image = (head.image ?? "").trim();
  const missingProperty = (property: string) => metaContent(html, "property", property) === null;
  const missingName = (key: string) => metaContent(html, "name", key) === null;

  if (!/<link\b[^>]*\brel\s*=\s*["'](?:shortcut )?icon["']/i.test(html)) {
    add.push(`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`);
  }
  const og: Array<[string, string]> = [
    ["og:type", "website"],
    ["og:site_name", name ? attr(name) : ""],
    ["og:title", title ? attr(title) : ""],
    ["og:description", description ? attr(description) : ""],
    ["og:url", url ? attr(url) : ""],
    ["og:image", image ? attr(image) : ""],
  ];
  for (const [property, value] of og) {
    if (value && missingProperty(property)) add.push(`<meta property="${property}" content="${value}" />`);
  }
  const hasImage = !!image || !missingProperty("og:image");
  const twitter: Array<[string, string]> = [
    ["twitter:card", hasImage ? "summary_large_image" : "summary"],
    ["twitter:title", title ? attr(title) : ""],
    ["twitter:description", description ? attr(description) : ""],
    ["twitter:image", image ? attr(image) : ""],
  ];
  for (const [key, value] of twitter) {
    if (value && missingName(key)) add.push(`<meta name="${key}" content="${value}" />`);
  }
  if (titleMatch && title !== (titleMatch[1] ?? "").replace(/\s+/g, " ").trim()) {
    html = html.replace(titleMatch[0], `<title>${title}</title>`);
  }
  if (add.length === 0) return html;
  const at = html.search(/<\/head>/i);
  return `${html.slice(0, at)}    ${add.join("\n    ")}\n  ${html.slice(at)}`;
}

export type ZaviPage = {
  title?: string;
  description?: string;
  jsonLd?: unknown;
};

export type ZaviPages = {
  site?: { jsonLd?: unknown };
  pages?: Record<string, ZaviPage>;
};

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

function jsonLdTags(items: unknown[]): string[] {
  return items.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, "\\u003c")}</script>`);
}

function insertBeforeHeadClose(html: string, tags: string[]): string {
  if (tags.length === 0) return html;
  const at = html.search(/<\/head>/i);
  if (at < 0) return html;
  return `${html.slice(0, at)}    ${tags.join("\n    ")}\n  ${html.slice(at)}`;
}

export function pageFileName(path: string): string | null {
  const clean = path.trim().replace(/^\/+|\/+$/g, "");
  if (clean === "") return "index.html";
  if (!/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(clean) || clean.split("/").includes("..")) return null;
  return `${clean}/index.html`;
}

const TITLE_TAG = /<title[^>]*>[\s\S]*?<\/title>/i;
const DESCRIPTION_TAG = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i;

function withPage(html: string, page: ZaviPage, jsonLd: unknown[]): string {
  const title = (page.title ?? "").trim();
  if (title) {
    const tag = `<title>${text(title)}</title>`;
    html = TITLE_TAG.test(html) ? html.replace(TITLE_TAG, tag) : insertBeforeHeadClose(html, [tag]);
  }
  const description = (page.description ?? "").trim();
  if (description) {
    const tag = `<meta name="description" content="${attr(description)}" />`;
    html = DESCRIPTION_TAG.test(html) ? html.replace(DESCRIPTION_TAG, tag) : insertBeforeHeadClose(html, [tag]);
  }
  return insertBeforeHeadClose(html, jsonLdTags(jsonLd));
}

const DERIVED_TAG =
  /\s*<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:title|og:description|og:url|twitter:title|twitter:description)["'][^>]*>/gi;

export function zaviPageHtml(html: string, head: ZaviHead, path: string, page: ZaviPage): string {
  const url = (head.url ?? "").trim();
  const pageUrl = url ? `${url.replace(/\/+$/, "")}/${path.trim().replace(/^\/+/, "")}` : "";
  return zaviHeadTags(withPage(html.replace(DERIVED_TAG, ""), page, listOf(page.jsonLd)), { ...head, url: pageUrl });
}

type EmitFile = (file: { type: "asset"; fileName: string; source: string }) => string;
type Bundle = Record<string, { type: string; source?: unknown }>;

export function zaviHead(head: ZaviHead, pages: ZaviPages = {}) {
  const home = pages.pages?.["/"] ?? {};
  const siteJsonLd = listOf(pages.site?.jsonLd);
  return {
    name: "zavi-head",
    enforce: "post" as const,
    transformIndexHtml: (html: string) =>
      zaviHeadTags(withPage(html, home, [...siteJsonLd, ...listOf(home.jsonLd)]), head),
    generateBundle(this: { emitFile: EmitFile }, _options: unknown, bundle: Bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") return;
      let built = String(index.source);
      for (const tag of jsonLdTags(listOf(home.jsonLd))) {
        const at = built.lastIndexOf(tag);
        if (at >= 0) built = built.slice(0, at) + built.slice(at + tag.length);
      }
      for (const [path, page] of Object.entries(pages.pages ?? {})) {
        const fileName = pageFileName(path);
        if (!fileName || fileName === "index.html" || bundle[fileName]) continue;
        this.emitFile({ type: "asset", fileName, source: zaviPageHtml(built, head, path, page ?? {}) });
      }
    },
  };
}
