
const SAFE = Symbol("zavi.safeHtml");

export type SafeHtml = { readonly [SAFE]: true; readonly value: string; toString(): string };

function make(value: string): SafeHtml {
  return Object.freeze({ [SAFE]: true as const, value, toString: () => value });
}

export function isSafeHtml(v: unknown): v is SafeHtml {
  return typeof v === "object" && v !== null && (v as { [SAFE]?: unknown })[SAFE] === true;
}

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (isSafeHtml(v)) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return make(out);
}

export function attr(v: unknown): SafeHtml {
  return make(escapeHtml(v));
}

export function localHref(path: string): SafeHtml {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("localHref takes an absolute local path");
  return make(escapeHtml(path));
}
