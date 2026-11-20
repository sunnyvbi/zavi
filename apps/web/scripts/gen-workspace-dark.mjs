import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tw = require("tailwindcss/colors");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/app/workspace-dark.css");

const NAMED = {
  white: "#ffffff",
  black: "#000000",
  success: "#167F50",
  successBg: "#F5FAF8",
  danger: "#CB2029",
  dangerBg: "#FEF2F3",
  warn: "#946300",
  warnBg: "#FFFAF0",
  marigold: "#FFC93D",
  mint: "#A3D9C0",
  coral: "#FF6B6B",
};
for (const fam of ["gray", "slate", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]) {
  for (const [k, v] of Object.entries(tw[fam])) NAMED[`${fam}-${k}`] = v;
}

const TOKEN = {
  cream: "rgb(var(--c-cream))",
  creamDeep: "rgb(var(--c-cream-deep))",
  bone: "rgb(var(--c-bone))",
  ink: "rgb(var(--c-ink))",
  inkSoft: "rgb(var(--c-ink-soft))",
  inkMuted: "rgb(var(--c-ink-muted))",
  inkLight: "rgb(var(--c-ink-light))",
  rule: "rgb(var(--c-rule))",
  darkStrong: "rgb(var(--c-dark-strong))",
};

const posix = (p) => p.split(sep).join("/");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = posix(p);
    if (rel.includes("/legacy/") || rel.includes("/marketing/") || rel.includes("/admin/")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const PREFIX = "(?:(?:hover|focus|focus-visible|focus-within|active|disabled|group-hover|group-focus-visible|placeholder|peer-checked|aria-selected|even|odd|after|before|data-\\[state=open\\]):)*";
const PROPS = "text|bg|border|border-t|border-b|border-l|border-r|border-x|border-y|ring|ring-offset|divide|placeholder|fill|stroke|outline|accent|caret|decoration";
const GRADIENT = "\\[(?:linear|radial|conic)-gradient\\([^\\]]*\\)\\]";
const VALUE = GRADIENT + "|\\[#[0-9a-fA-F]{3,8}\\]|" + Object.keys(NAMED).sort((a, b) => b.length - a.length).join("|");
const RE = new RegExp(`(?<![\\w-])(${PREFIX})(${PROPS})-(${VALUE})(?:/(\\d{1,3}))?(?![\\w-])`, "g");

function hexToRgb(hex) {
  let h = hex.replace(/^\[?#|\]$/g, "").replace("]", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function toHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l, c: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l, c: d };
}
const hsl = (h, s, l) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

function mapColor(kind, hex) {
  const { h, s, l, c } = toHsl(hexToRgb(hex));
  const neutral = c < 0.07;
  if (kind === "text") {
    if (neutral) {
      if (l < 0.25) return TOKEN.ink;
      if (l < 0.42) return TOKEN.inkMuted;
      if (l < 0.6) return TOKEN.inkLight;
      if (l < 0.85) return "rgb(122 122 122)";
      return null;
    }
    return l < 0.55 ? hsl(h, Math.min(s, 0.8), 0.66) : null;
  }
  if (kind === "bg") {
    if (neutral) {
      if (l >= 0.985) return TOKEN.cream;
      if (l >= 0.95) return TOKEN.creamDeep;
      if (l >= 0.88) return TOKEN.bone;
      if (l >= 0.7) return TOKEN.darkStrong;
      if (l >= 0.3) return null;
      if (l < 0.12) return TOKEN.ink;
      if (l < 0.2) return TOKEN.inkSoft;
      return "rgb(203 203 203)";
    }
    if (l >= 0.85) return hsl(h, Math.min(s, 0.4), 0.15);
    if (l >= 0.6) return hsl(h, Math.min(s, 0.45), 0.24);
    return null;
  }
  if (neutral) {
    if (l >= 0.8) return TOKEN.rule;
    if (l >= 0.6) return TOKEN.darkStrong;
    if (l >= 0.3) return null;
    return TOKEN.ink;
  }
  return l >= 0.6 ? hsl(h, Math.min(s, 0.4), 0.3) : null;
}

function mapGradient(value) {
  let mapped = false;
  const css = value.replace(/#[0-9a-fA-F]{3,8}/g, (hex) => {
    const c = mapColor("bg", hex);
    if (!c) return hex;
    mapped = true;
    return c;
  });
  return mapped ? css.replace(/_/g, " ") : null;
}

const KIND = (p) =>
  ["text", "placeholder", "fill", "stroke", "accent", "caret"].includes(p) ? "text" : p === "bg" ? "bg" : "border";
const PROP = {
  text: "color",
  bg: "background-color",
  border: "border-color",
  "border-t": "border-top-color",
  "border-b": "border-bottom-color",
  "border-l": "border-left-color",
  "border-r": "border-right-color",
  "border-x": "border-left-color;border-right-color",
  "border-y": "border-top-color;border-bottom-color",
  ring: "--tw-ring-color",
  "ring-offset": "--tw-ring-offset-color",
  divide: "border-color",
  placeholder: "color",
  fill: "fill",
  stroke: "stroke",
  outline: "outline-color",
  accent: "accent-color",
  caret: "caret-color",
  decoration: "text-decoration-color",
};

const esc = (s) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
function selector(cls, prefixes, prop) {
  let sel = `html.dark .workspace-shell `;
  const pseudo = [];
  for (const p of prefixes) {
    if (p === "group-hover") sel += ".group:hover ";
    else if (p === "peer-checked") sel += ".peer:checked ~ ";
    else if (p === "hover") pseudo.push(":hover");
    else if (p === "focus") pseudo.push(":focus");
    else if (p === "focus-visible") pseudo.push(":focus-visible");
    else if (p === "focus-within") pseudo.push(":focus-within");
    else if (p === "group-focus-visible") sel += ".group:focus-visible ";
    else if (p === "even") pseudo.push(":nth-child(even)");
    else if (p === "odd") pseudo.push(":nth-child(odd)");
    else if (p === "after") pseudo.push("::after");
    else if (p === "before") pseudo.push("::before");
    else if (p === "active") pseudo.push(":active");
    else if (p === "disabled") pseudo.push(":disabled");
    else if (p === "aria-selected") pseudo.push('[aria-selected="true"]');
    else if (p === "data-[state=open]") pseudo.push('[data-state="open"]');
    else if (p === "placeholder") pseudo.push("::placeholder");
  }
  sel += "." + esc(cls) + pseudo.join("");
  if (prop === "divide") sel += " > :not([hidden]) ~ :not([hidden])";
  if (prop === "placeholder") sel += "::placeholder";
  return sel;
}

const withAlpha = (color, alpha) =>
  alpha == null ? color : color.startsWith("rgb(var(")
    ? color.replace("))", `) / ${alpha})`)
    : color.startsWith("hsl(")
      ? color.replace(")", ` / ${alpha})`)
      : color.replace(")", ` / ${alpha})`);

const THEME_INVARIANT = new Set(["bg-black", "bg-[#fff]", "bg-[#000]", "bg-[#232426]"]);

export function generate() {
const workspaceFiles = [...walk(join(root, "src/components")), ...walk(join(root, "src/app/workspace"))];

const MARKETING_IMPORT = /from\s+["']@\/components\/marketing\/([\w/-]+)["']/g;
const importedMarketing = new Set();
for (const file of workspaceFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(MARKETING_IMPORT)) {
    const target = join(root, "src/components/marketing", `${m[1]}.tsx`);
    try {
      if (statSync(target).isFile()) importedMarketing.add(target);
    } catch {
    }
  }
}

const seen = new Map();
for (const file of [...workspaceFiles, ...importedMarketing]) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(RE)) seen.set(m[0], m);
}

const rules = [];
const darkBgSelectors = new Set(["bg-ink", "bg-inkSoft", "bg-black", "bg-ink\\/70", "bg-ink\\/80", "bg-ink\\/90"]);
const lightTextClasses = new Set(["text-white", "text-cream"]);

for (const [cls, m] of seen) {
  const prefixes = m[1] ? m[1].split(":").filter(Boolean) : [];
  const prop = m[2];
  const raw = m[3];
  const alpha = m[4] ? String(Number(m[4]) / 100) : null;
  if (raw.startsWith("[") && raw.includes("-gradient(")) {
    const css = mapGradient(raw.slice(1, -1));
    if (css) rules.push(`${selector(cls, prefixes, prop)} { background-image: ${css}; }`);
    continue;
  }
  const hex = raw.startsWith("[") ? raw.slice(1, -1) : NAMED[raw];
  const kind = KIND(prop);
  if (raw === "white" && kind === "text") { lightTextClasses.add(cls); continue; }
  if (raw === "black" && kind === "bg" && alpha) continue;
  if (THEME_INVARIANT.has(cls)) continue;
  const { l, c } = toHsl(hexToRgb(hex));
  const color = mapColor(kind, hex);
  if (!color) continue;
  if (kind === "bg" && c < 0.07 && l < 0.3 && !alpha) darkBgSelectors.add(esc(cls));
  if (kind === "text" && c < 0.07 && l >= 0.85) { lightTextClasses.add(cls); continue; }
  const value = withAlpha(color, alpha);
  const decl = PROP[prop].split(";").map((p) => `${p}: ${value}`).join("; ");
  rules.push(`${selector(cls, prefixes, prop)} { ${decl}; }`);
}

const bgList = [...darkBgSelectors].map((s) => "." + s).join(", ");
const lightList = [...lightTextClasses].map((c) => "." + esc(c));
rules.push(
  `${lightList.map((c) => `html.dark .workspace-shell :is(${bgList}) ${c}, html.dark .workspace-shell :is(${bgList})${c}`).join(",\n")} { color: rgb(var(--c-cream)); }`,
);

rules.push(`html.dark .workspace-shell .\\[\\&\\>div\\]\\:\\!bg-white > div { background-color: rgb(var(--c-cream)) !important; }`);

const header = `/* GENERATED by scripts/gen-workspace-dark.mjs — do not edit by hand.
 * Dark-mode remap for hardcoded light-theme colors used inside .workspace-shell.
 * Re-run: node apps/web/scripts/gen-workspace-dark.mjs */\n`;
const LAST = [
  `html.dark .workspace-shell .disabled\\:text-inkLight:disabled { color: rgb(var(--c-ink-light)); }`,
];
  return { css: header + [...rules.sort(), ...LAST].join("\n") + "\n", rules: rules.length + LAST.length, classes: seen.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = generate();
  writeFileSync(OUT, out.css);
  console.log(`wrote ${out.rules} rules from ${out.classes} classes → ${OUT}`);
}
