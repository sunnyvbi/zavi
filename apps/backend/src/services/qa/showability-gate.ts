
export const SHOWABILITY_SENTINEL =
  /(<script|onerror\s*=|AAAA{36,}|XSSPROBE|\bPROBE\b)/i;

export const SHOWABILITY_VIEWPORTS: readonly { name: string; width: number; height: number }[] = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812 },
] as const;

export const SHOWABILITY_MIN_BODY_LEN = 40;

export type ShowabilityChecks = {
  overflow: boolean;
  offenders: string[];
  scrollWidth: number;
  innerWidth: number;
  dirtyText: boolean;
  ctaCount: number;
  bodyLen: number;
  bodySample: string;
  headingFontFamily: string;
  bodyFontFamily: string;
};

export type ShowabilitySnapshot = {
  viewport: string;
  path: string;
  status: number;
  consoleErrors: string[];
  pageErrors: string[];
  loadErr: string | null;
  checks: ShowabilityChecks | null;
};

export type ShowabilityResult = {
  pass: boolean;
  url: string;
  snapshots: ShowabilitySnapshot[];
  fails: string[];
  firstFailure: string;
  fontWarnings: string[];
};

export const GENERIC_FONT_FIRST_TOKEN =
  /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|-apple-system|blinkmacsystemfont)$/i;

export function firstFontToken(family: string): string {
  return (family || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
}

export function normalizeFontToken(family: string): string {
  const t = firstFontToken(family);
  const m = t.match(/^__(.+?)(?:_Fallback)?_[A-Za-z0-9]+$/);
  return (m ? m[1] : t).toLowerCase();
}

export function headingFontLooksFallback(family: string): boolean {
  const first = firstFontToken(family);
  return first === "" || GENERIC_FONT_FIRST_TOKEN.test(first);
}

export type FontParityResult = { parity: boolean; mismatches: string[] };

export function evaluateFontParity(a: ShowabilityResult, b: ShowabilityResult): FontParityResult {
  const index = (r: ShowabilityResult): Map<string, ShowabilityChecks> => {
    const m = new Map<string, ShowabilityChecks>();
    for (const s of r.snapshots) if (s.checks) m.set(`${s.viewport}|${s.path}`, s.checks);
    return m;
  };
  const ma = index(a);
  const mb = index(b);
  const mismatches: string[] = [];
  for (const [key, ca] of ma) {
    const cb = mb.get(key);
    if (!cb) continue;
    if (normalizeFontToken(ca.headingFontFamily) !== normalizeFontToken(cb.headingFontFamily)) {
      mismatches.push(`[${key}] heading font differs: "${ca.headingFontFamily}" vs "${cb.headingFontFamily}"`);
    }
    if (normalizeFontToken(ca.bodyFontFamily) !== normalizeFontToken(cb.bodyFontFamily)) {
      mismatches.push(`[${key}] body font differs: "${ca.bodyFontFamily}" vs "${cb.bodyFontFamily}"`);
    }
  }
  return { parity: mismatches.length === 0, mismatches };
}

export function evaluateShowability(
  url: string,
  snapshots: ShowabilitySnapshot[],
): ShowabilityResult {
  const fails: string[] = [];
  for (const s of snapshots) {
    const tag = `[${s.viewport}${s.path}]`;
    if (s.loadErr) fails.push(`${tag} load failed: ${s.loadErr}`);
    if (s.status && s.status >= 400) fails.push(`${tag} HTTP ${s.status}`);
    const c = s.checks;
    if (c?.overflow) fails.push(`${tag} horizontal overflow ${c.scrollWidth}>${c.innerWidth}`);
    if (c?.offenders?.length) {
      fails.push(`${tag} ${c.offenders.length} element(s) past viewport: ${c.offenders.join(", ")}`);
    }
    if (c?.dirtyText) fails.push(`${tag} QA sentinel / unescaped markup visible in rendered text`);
    if (s.pageErrors.length) fails.push(`${tag} runtime pageerror: ${s.pageErrors[0]}`);
    if (c && c.bodyLen < SHOWABILITY_MIN_BODY_LEN) {
      fails.push(`${tag} near-empty page (body ${c.bodyLen} chars)`);
    }
    if (s.path === "/" && c && c.ctaCount === 0) fails.push(`${tag} no visible primary CTA`);
  }
  const fontWarnings: string[] = [];
  for (const s of snapshots) {
    const c = s.checks;
    if (!c) continue;
    if (headingFontLooksFallback(c.headingFontFamily)) {
      fontWarnings.push(
        `[${s.viewport}${s.path}] heading font resolves to a generic fallback ("${c.headingFontFamily}") — the next/font display face may not be loading`,
      );
    }
  }
  return { pass: fails.length === 0, url, snapshots, fails, firstFailure: fails[0] ?? "", fontWarnings };
}

export function browserCheckExpr(): string {
  return `() => {
  const overflow = document.documentElement.scrollWidth > window.innerWidth + 4;
  const offenders = [...document.querySelectorAll('body *')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 8; })
    .slice(0, 8)
    .map(e => (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : '')));
  const text = (document.body && document.body.innerText) || '';
  const dirtyText = ${SHOWABILITY_SENTINEL.toString()}.test(text);
  const ctas = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')]
    .filter(e => { const r = e.getBoundingClientRect(); const t = (e.innerText||e.value||'').trim();
      return r.width > 0 && r.height > 0 && /sign\\s?up|get started|browse|book|create|log\\s?in|sign\\s?in|start|continue|search|list|add|post/i.test(t); });
  const headEl = document.querySelector('h1,h2,h3');
  const headingFontFamily = headEl ? getComputedStyle(headEl).fontFamily : '';
  const bodyFontFamily = document.body ? getComputedStyle(document.body).fontFamily : '';
  return { overflow, offenders, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
           dirtyText, ctaCount: ctas.length, bodyLen: text.length,
           bodySample: text.replace(/\\s+/g,' ').slice(0, 160),
           headingFontFamily, bodyFontFamily };
}`;
}

const trunc = (s: string, n = 200): string => (s.length > n ? s.slice(0, n) : s);

export type ChromiumLauncher = {
  launch(opts: { headless: boolean; args?: string[] }): Promise<{
    newContext(opts: { viewport: { width: number; height: number } }): Promise<{
      newPage(): Promise<ShowabilityPage>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
};

export type ShowabilityPage = {
  on(event: "console", cb: (m: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", cb: (e: unknown) => void): void;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(fn: string): Promise<ShowabilityChecks>;
};

export type RunShowabilityGateInput = {
  url: string;
  paths?: string[];
  navTimeoutMs?: number;
};

async function realChromium(): Promise<ChromiumLauncher> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("playwright" as string);
  return mod.chromium as ChromiumLauncher;
}

export async function runShowabilityGate(
  input: RunShowabilityGateInput,
  launcher?: ChromiumLauncher,
): Promise<ShowabilityResult> {
  const base = input.url.replace(/\/+$/, "");
  const paths = (input.paths && input.paths.length > 0 ? input.paths : ["/"])
    .map((p) => p.trim())
    .filter(Boolean);
  const navTimeout = input.navTimeoutMs ?? 45000;
  const checkExpr = browserCheckExpr();

  const chromium = launcher ?? (await realChromium());
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const snapshots: ShowabilitySnapshot[] = [];
  try {
    for (const vp of SHOWABILITY_VIEWPORTS) {
      for (const path of paths) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        let status = 0;
        let loadErr: string | null = null;
        let checks: ShowabilityChecks | null = null;
        try {
          const page = await ctx.newPage();
          page.on("console", (m) => {
            if (m.type() === "error") consoleErrors.push(trunc(m.text()));
          });
          page.on("pageerror", (e) => pageErrors.push(trunc(String(e))));
          const target = base + (path === "/" ? "/" : path);
          try {
            const resp = await page.goto(target, { waitUntil: "networkidle", timeout: navTimeout });
            status = resp ? resp.status() : 0;
            await page.waitForTimeout(1200);
          } catch (e) {
            loadErr = trunc(String(e));
          }
          try {
            checks = await page.evaluate(checkExpr);
          } catch (e) {
            loadErr = loadErr ?? trunc(String(e));
          }
        } catch (e) {
          loadErr = loadErr ?? trunc(String(e));
        } finally {
          await ctx.close().catch(() => {});
        }
        snapshots.push({ viewport: vp.name, path, status, consoleErrors, pageErrors, loadErr, checks });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return evaluateShowability(input.url, snapshots);
}

export type ShowabilityGateMode = "off" | "shadow" | "enforce";
export function resolveShowabilityGateMode(): ShowabilityGateMode {
  const raw = (process.env.SHOWABILITY_GATE_MODE ?? "").trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "enforce") return "enforce";
  return "off";
}
