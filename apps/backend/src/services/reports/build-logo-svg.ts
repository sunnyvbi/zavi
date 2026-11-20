
import type { LogoSpec, LogoElement } from "./schema";

const DEFAULT_VIEWBOX = "0 0 64 64";

const FONT_STACK: Record<"sans" | "serif" | "mono", string> = {
  sans: "'DejaVu Sans', 'Liberation Sans', 'Noto Sans', Helvetica, Arial, sans-serif",
  serif:
    "'Liberation Serif', 'Noto Serif', 'DejaVu Serif', Georgia, 'Times New Roman', serif",
  mono: "'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Courier New', Courier, monospace",
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function num(n: number): string {
  return Number(n.toFixed(3)).toString();
}

function paint(el: {
  fill?: string;
  stroke?: string;
  stroke_width?: number;
}): string {
  const parts: string[] = [];
  if (el.fill !== undefined) parts.push(`fill="${xmlEscape(el.fill)}"`);
  if (el.stroke !== undefined) parts.push(`stroke="${xmlEscape(el.stroke)}"`);
  if (el.stroke_width !== undefined)
    parts.push(`stroke-width="${num(el.stroke_width)}"`);
  return parts.length ? " " + parts.join(" ") : "";
}

function buildElement(el: LogoElement): string {
  switch (el.type) {
    case "path":
      return `<path d="${xmlEscape(el.d)}"${paint(el)} />`;
    case "rect": {
      const r =
        (el.rx !== undefined ? ` rx="${num(el.rx)}"` : "") +
        (el.ry !== undefined ? ` ry="${num(el.ry)}"` : "");
      return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.width)}" height="${num(el.height)}"${r}${paint(el)} />`;
    }
    case "circle":
      return `<circle cx="${num(el.cx)}" cy="${num(el.cy)}" r="${num(el.r)}"${paint(el)} />`;
    case "ellipse":
      return `<ellipse cx="${num(el.cx)}" cy="${num(el.cy)}" rx="${num(el.rx)}" ry="${num(el.ry)}"${paint(el)} />`;
    case "line":
      return `<line x1="${num(el.x1)}" y1="${num(el.y1)}" x2="${num(el.x2)}" y2="${num(el.y2)}"${el.stroke !== undefined ? ` stroke="${xmlEscape(el.stroke)}"` : ""}${el.stroke_width !== undefined ? ` stroke-width="${num(el.stroke_width)}"` : ""} />`;
    case "polygon":
      return `<polygon points="${xmlEscape(el.points)}"${paint(el)} />`;
    case "polyline":
      return `<polyline points="${xmlEscape(el.points)}"${paint(el)} />`;
    case "text": {
      const attrs = [
        `x="${num(el.x)}"`,
        `y="${num(el.y)}"`,
        `font-family="${xmlEscape(FONT_STACK[el.font_family])}"`,
        `font-size="${num(el.font_size)}"`,
      ];
      if (el.font_weight) attrs.push(`font-weight="${xmlEscape(el.font_weight)}"`);
      if (el.fill !== undefined) attrs.push(`fill="${xmlEscape(el.fill)}"`);
      if (el.text_anchor) attrs.push(`text-anchor="${xmlEscape(el.text_anchor)}"`);
      return `<text ${attrs.join(" ")}>${xmlEscape(el.content)}</text>`;
    }
  }
}

export function buildLogoSvg(spec: LogoSpec): string {
  const viewBox = spec.viewBox ?? DEFAULT_VIEWBOX;
  const [, , w, h] = viewBox.split(" ");
  const bg =
    spec.background !== undefined
      ? `<rect x="0" y="0" width="${xmlEscape(w)}" height="${xmlEscape(h)}" fill="${xmlEscape(spec.background)}" />`
      : "";
  const body = spec.elements.map(buildElement).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${xmlEscape(viewBox)}" width="${xmlEscape(w)}" height="${xmlEscape(h)}">${bg}${body}</svg>`;
}
