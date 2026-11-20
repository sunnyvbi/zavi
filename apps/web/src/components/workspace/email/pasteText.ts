const MERGE_TAG = /\{\{[^{}\n]{0,60}\}\}|\*\|[^|*\n]{0,60}\|\*|\{%[^%\n]{0,60}%\}/;
const HTML_SOURCE = /<\/?(?:html|head|body|div|p|span|table|tbody|tr|td|a|br|img|h[1-6]|strong|em|b|i|ul|ol|li|style|meta|font|center)\b[^>]*>/i;

export const HTML_SOURCE_WARNING =
  "This looks like HTML code. Zavi sends your text as written, so the tags would reach people as typed. Paste the email as you see it in your editor instead.";

export function mergeTagIn(...texts: string[]): string | null {
  for (const t of texts) {
    const m = MERGE_TAG.exec(t);
    if (m) return m[0];
  }
  return null;
}

export function mergeTagWarning(tag: string): string {
  return `Zavi sends your words as written, so ${tag} would reach people as typed. Remove it or write the greeting out.`;
}

export function looksLikeHtml(text: string): boolean {
  return HTML_SOURCE.test(text);
}

export function pastedWithLinks(html: string, plain: string): string | null {
  if (!html || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = plain || doc.body.textContent || "";
  let out = "";
  let at = 0;
  let changed = false;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = (a.getAttribute("href") ?? "").trim();
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(href) || !text || text === href) continue;
    const found = base.indexOf(text, at);
    if (found < 0) continue;
    const end = found + text.length;
    if (base.startsWith(` (${href})`, end)) continue;
    out += `${base.slice(at, end)} (${href})`;
    at = end;
    changed = true;
  }
  return changed ? out + base.slice(at) : null;
}
