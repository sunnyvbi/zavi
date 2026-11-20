const COMPACT_PREFIXES = ["[@container(max-width:600px)]:", "compact:"];

const PAINT_FILL = /^bg-(?!transparent$|inherit$|none$)[a-zA-Z[]/;
const PAINT_BORDER_COLOR = /^border-(?![tblrxy]$)(?!\d)[a-zA-Z[]/;
const PAD = /^p(x)?-(\d+(?:\.\d+)?)$/;
const GAP = /^gap(-[xy])?-(.+)$/;

function hasVariantPrefix(token: string): boolean {
  let depth = 0;
  for (const ch of token) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === ":" && depth === 0) return true;
  }
  return false;
}

export function resolve(el: Element, compact: boolean): string[] {
  const out: string[] = [];
  for (const t of (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) {
    const prefix = COMPACT_PREFIXES.find((p) => t.startsWith(p));
    if (prefix) {
      if (compact) out.push(t.slice(prefix.length));
    } else if (!hasVariantPrefix(t)) {
      out.push(t);
    }
  }
  return out;
}

export function padPx(el: Element, compact: boolean): number {
  let px = 0;
  for (const t of resolve(el, compact)) {
    const m = PAD.exec(t);
    if (m) px = Number(m[2]) * 4;
  }
  return px;
}

export function paints(el: Element, compact: boolean): boolean {
  const t = resolve(el, compact);
  if (t.some((x) => PAINT_FILL.test(x))) return true;
  if (t.includes("ring-1")) return true;
  return t.includes("border") && t.some((x) => PAINT_BORDER_COLOR.test(x) && x !== "border-transparent");
}

export function gapUnits(el: Element, compact: boolean): Record<string, string> {
  const g: Record<string, string> = {};
  for (const t of resolve(el, compact)) {
    const m = GAP.exec(t);
    if (m) g[m[1] ?? ""] = m[2];
  }
  return g;
}

function flexItems(el: Element, compact: boolean): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(el.children)) {
    if (resolve(child, compact).includes("contents")) out.push(...flexItems(child, compact));
    else out.push(child);
  }
  return out;
}

function isControl(el: Element): boolean {
  return el.tagName === "BUTTON" || el.tagName === "A";
}

export type Violation = { row: string; painted: string[]; leaking: string[] };

export function mixedRowViolations(root: Element, compact: boolean): Violation[] {
  const out: Violation[] = [];
  const boxes = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const box of boxes) {
    const cls = resolve(box, compact);
    if (!cls.includes("flex") || cls.includes("contents")) continue;
    if (Object.keys(gapUnits(box, compact)).length === 0) continue;

    const controls = flexItems(box, compact).filter(isControl);
    if (controls.length < 2) continue;

    const painted = controls.filter((c) => paints(c, compact));
    const leaking = controls.filter((c) => !paints(c, compact) && padPx(c, compact) > 0);
    if (painted.length && leaking.length) {
      out.push({
        row: cls.join(" ").slice(0, 80),
        painted: painted.map((c) => c.textContent?.trim().slice(0, 24) ?? ""),
        leaking: leaking.map((c) => `${c.textContent?.trim().slice(0, 24)} (+${padPx(c, compact)}px each side)`),
      });
    }
  }
  return out;
}
