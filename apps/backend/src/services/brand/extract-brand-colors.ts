
export type BrandColorEvidence = {
  hex: string;
  signal:
    | "meta_theme_color"
    | "css_var_primary"
    | "css_var_accent"
    | "tailwind_token"
    | "cta_declaration"
    | "frequency";
  weight: number;
  detail?: string;
};

export type ExtractedBrand = {
  primary: string | null;
  accent: string | null;
  bg: string | null;
  text: string | null;
  evidence: BrandColorEvidence[];
};

export type BrandSources = {
  html: string;
  css: string[];
};

const W = {
  meta_theme_color: 100,
  css_var_primary: 80,
  css_var_accent: 75,
  tailwind_token: 70,
  cta_declaration: 40,
  frequency: 10,
} as const;

const DETAIL_MAX = 120;

export function normalizeHex(raw: string): string | null {
  const m = raw.trim().match(/^#?([0-9a-fA-F]{3,8})$/);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (h.length === 6) return `#${h}`;
  if (h.length === 8) return `#${h.slice(0, 6)}`;
  return null;
}

export function rgbToHex(raw: string): string | null {
  const m = raw.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const parts = m[1]
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const chan = parts.slice(0, 3).map((p) => {
    if (p.endsWith("%")) return Math.round((parseFloat(p) / 100) * 255);
    return Math.round(parseFloat(p));
  });
  if (chan.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
  return `#${chan.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function toHex(raw: string): string | null {
  return normalizeHex(raw) ?? rgbToHex(raw);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function lightness(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function saturation(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

export function isAccentCandidate(hex: string): boolean {
  if (!isBrandCandidate(hex)) return false;
  const l = lightness(hex);
  return l >= 0.18 && l <= 0.82 && saturation(hex) >= 0.35;
}

export function isBrandCandidate(hex: string): boolean {
  const l = lightness(hex);
  if (l > 0.93 || l < 0.06) return false;
  return saturation(hex) >= 0.15;
}

function pushEvidence(
  out: BrandColorEvidence[],
  hex: string | null,
  signal: BrandColorEvidence["signal"],
  detail?: string,
): void {
  if (!hex) return;
  out.push({ hex, signal, weight: W[signal], detail: detail?.slice(0, DETAIL_MAX) });
}

function detectThemeColor(html: string, out: BrandColorEvidence[]): void {
  const re = /<meta\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    if (!/name\s*=\s*["']?theme-color/i.test(tag)) continue;
    const c = tag.match(/content\s*=\s*["']([^"']+)["']/i);
    if (c) pushEvidence(out, toHex(c[1]), "meta_theme_color", tag);
  }
}

const PRIMARY_VAR = /--(?:[a-z0-9]+-)*(?:primary|brand)(?:-\d{2,3})?\s*:/i;
const ACCENT_VAR = /--(?:[a-z0-9]+-)*(?:accent|cta|secondary)(?:-\d{2,3})?\s*:/i;
const FOREGROUND_VAR = /(?:foreground|contrast|text|on-)/i;

function detectCssVars(
  css: string,
  out: BrandColorEvidence[],
  suppressed: Set<string>,
): void {
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+)[;}]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const [, name, valueRaw] = m;
    const decl = `${name}: ${valueRaw.trim()}`;
    const hex = toHex(valueRaw.trim());
    if (FOREGROUND_VAR.test(name)) {
      if (hex) suppressed.add(hex);
      continue;
    }
    if (!hex) continue;
    if (PRIMARY_VAR.test(`${name}:`)) pushEvidence(out, hex, "css_var_primary", decl);
    else if (ACCENT_VAR.test(`${name}:`)) pushEvidence(out, hex, "css_var_accent", decl);
  }
}

function detectTailwindTokens(html: string, out: BrandColorEvidence[]): void {
  const re = /["']?(primary|brand|accent)["']?\s*:\s*["'](#[0-9a-fA-F]{3,8})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    pushEvidence(out, toHex(m[2]), "tailwind_token", m[0]);
  }
}

function detectCtaDeclarations(css: string, out: BrandColorEvidence[]): void {
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css))) {
    const [, selector, body] = m;
    if (!/\b(btn|button|cta|primary)\b/i.test(selector)) continue;
    const bg = body.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (bg) pushEvidence(out, toHex(bg[1].trim()), "cta_declaration", `${selector.trim()} { ${bg[0]} }`);
  }
}

function detectFrequency(css: string, out: BrandColorEvidence[]): void {
  const counts = new Map<string, number>();
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g;
  for (const raw of css.match(re) ?? []) {
    const hex = toHex(raw);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const [hex, n] of counts) {
    out.push({ hex, signal: "frequency", weight: W.frequency, detail: `${n}x in stylesheet` });
  }
}

function scoreBySlot(
  evidence: BrandColorEvidence[],
  signals: BrandColorEvidence["signal"][],
  suppressed: Set<string>,
): Map<string, number> {
  const named = new Set(evidence.filter((e) => e.signal !== "frequency").map((e) => e.hex));
  const scores = new Map<string, number>();
  for (const e of evidence) {
    if (!signals.includes(e.signal)) continue;
    if (!isBrandCandidate(e.hex)) continue;
    if (suppressed.has(e.hex) && !named.has(e.hex)) continue;
    scores.set(e.hex, (scores.get(e.hex) ?? 0) + e.weight);
  }
  return scores;
}

function topOf(scores: Map<string, number>, exclude?: (string | null)[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const [hex, score] of scores) {
    if (exclude?.includes(hex)) continue;
    if (score > bestScore) {
      best = hex;
      bestScore = score;
    }
  }
  return best;
}

function neutralSlots(evidence: BrandColorEvidence[]): { bg: string | null; text: string | null } {
  let bg: string | null = null;
  let text: string | null = null;
  let bgScore = -1;
  let textScore = -1;
  const freq = new Map<string, number>();
  for (const e of evidence) {
    if (e.signal !== "frequency") continue;
    const n = parseInt(e.detail ?? "0", 10) || 1;
    freq.set(e.hex, (freq.get(e.hex) ?? 0) + n);
  }
  for (const [hex, n] of freq) {
    const l = lightness(hex);
    if (l > 0.93 && n > bgScore) {
      bg = hex;
      bgScore = n;
    }
    if (l < 0.2 && n > textScore) {
      text = hex;
      textScore = n;
    }
  }
  return { bg, text };
}

export function extractBrandColors(sources: BrandSources): ExtractedBrand {
  const evidence: BrandColorEvidence[] = [];
  const suppressed = new Set<string>();
  const allCss = sources.css.join("\n");

  detectThemeColor(sources.html, evidence);
  detectTailwindTokens(sources.html, evidence);
  const inlineStyles = (sources.html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join("\n");
  const css = `${allCss}\n${inlineStyles}`;
  detectCssVars(css, evidence, suppressed);
  detectCtaDeclarations(css, evidence);
  detectFrequency(css, evidence);

  const primaryScores = scoreBySlot(
    evidence,
    ["meta_theme_color", "css_var_primary", "tailwind_token", "cta_declaration", "frequency"],
    suppressed,
  );
  const primary = topOf(primaryScores);

  const accentScores = scoreBySlot(
    evidence,
    ["css_var_accent", "tailwind_token", "frequency"],
    suppressed,
  );
  for (const hex of [...accentScores.keys()]) {
    if (!isAccentCandidate(hex)) accentScores.delete(hex);
  }
  const accent = topOf(accentScores, [primary]);

  const { bg, text } = neutralSlots(evidence);

  const chosen = new Set([primary, accent].filter(Boolean) as string[]);
  const kept = evidence
    .filter((e) => chosen.has(e.hex) && e.signal !== "frequency")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);

  return { primary, accent, bg, text, evidence: kept };
}
