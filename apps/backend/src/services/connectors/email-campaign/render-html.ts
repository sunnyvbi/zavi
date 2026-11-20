
const ESC: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

const URL_RE = /https?:\/\/[^\s<>"']+/g;

function line(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const at = m.index ?? 0;
    out += esc(text.slice(last, at)) + `<a href="${esc(url)}">${esc(url)}</a>`;
    last = at + url.length;
  }
  return out + esc(text.slice(last));
}

export function renderEmailHtml(text: string, opts: { preheader?: string | null } = {}): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split("\n").map(line).join("<br>")}</p>`);
  const pre = opts.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(opts.preheader.trim())}</div>`
    : "";
  return `<!doctype html><html><body>${pre}${paragraphs.join("")}</body></html>`;
}
