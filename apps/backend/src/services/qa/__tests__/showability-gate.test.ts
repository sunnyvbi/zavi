
import { describe, it, expect, afterEach } from "vitest";
import {
  evaluateShowability,
  runShowabilityGate,
  resolveShowabilityGateMode,
  browserCheckExpr,
  evaluateFontParity,
  headingFontLooksFallback,
  firstFontToken,
  normalizeFontToken,
  SHOWABILITY_SENTINEL,
  SHOWABILITY_VIEWPORTS,
  type ShowabilityChecks,
  type ShowabilitySnapshot,
  type ChromiumLauncher,
} from "../showability-gate";

const URL = "https://acme-ab12.thepraxis.ai";

function okChecks(over: Partial<ShowabilityChecks> = {}): ShowabilityChecks {
  return {
    overflow: false,
    offenders: [],
    scrollWidth: 1280,
    innerWidth: 1280,
    dirtyText: false,
    ctaCount: 2,
    bodyLen: 800,
    bodySample: "Welcome to Acme — browse cars near you",
    headingFontFamily: "__Fraunces_abc123, __Fraunces_Fallback_abc123, serif",
    bodyFontFamily: "__Inter_def456, __Inter_Fallback_def456, system-ui, sans-serif",
    ...over,
  };
}

function snap(over: Partial<ShowabilitySnapshot> = {}): ShowabilitySnapshot {
  return {
    viewport: "desktop",
    path: "/",
    status: 200,
    consoleErrors: [],
    pageErrors: [],
    loadErr: null,
    checks: okChecks(),
    ...over,
  };
}

describe("evaluateShowability — pure verdict", () => {
  it("PASSES when every snapshot is clean", () => {
    const r = evaluateShowability(URL, [snap(), snap({ viewport: "mobile" })]);
    expect(r.pass).toBe(true);
    expect(r.fails).toEqual([]);
    expect(r.firstFailure).toBe("");
    expect(r.url).toBe(URL);
  });

  it("FAILS on horizontal overflow", () => {
    const r = evaluateShowability(URL, [
      snap({ checks: okChecks({ overflow: true, scrollWidth: 1440, innerWidth: 1280 }) }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/horizontal overflow 1440>1280/);
  });

  it("FAILS on element boxes past the viewport (offenders)", () => {
    const r = evaluateShowability(URL, [
      snap({ checks: okChecks({ offenders: ["div.hero", "img.banner"] }) }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.fails[0]).toMatch(/2 element\(s\) past viewport: div\.hero, img\.banner/);
  });

  it("FAILS on a visible QA sentinel in rendered text", () => {
    const r = evaluateShowability(URL, [snap({ checks: okChecks({ dirtyText: true }) })]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/QA sentinel \/ unescaped markup/);
  });

  it("FAILS on a runtime pageerror", () => {
    const r = evaluateShowability(URL, [snap({ pageErrors: ["TypeError: x is not a function"] })]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/runtime pageerror: TypeError/);
  });

  it("FAILS on a load failure", () => {
    const r = evaluateShowability(URL, [snap({ loadErr: "net::ERR_CONNECTION_REFUSED", checks: null })]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/load failed: net::ERR_CONNECTION_REFUSED/);
  });

  it("FAILS on an HTTP >= 400 status", () => {
    const r = evaluateShowability(URL, [snap({ status: 502 })]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/HTTP 502/);
  });

  it("FAILS on a near-empty page", () => {
    const r = evaluateShowability(URL, [snap({ checks: okChecks({ bodyLen: 10 }) })]);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/near-empty page \(body 10 chars\)/);
  });

  it("FAILS when the homepage has NO primary CTA, but only on '/'", () => {
    const noCta = okChecks({ ctaCount: 0 });
    expect(evaluateShowability(URL, [snap({ path: "/", checks: noCta })]).pass).toBe(false);
    expect(evaluateShowability(URL, [snap({ path: "/search", checks: okChecks({ ctaCount: 0 }) })]).pass).toBe(true);
  });

  it("console errors alone do NOT fail the gate (evidence-only, like the BTL harness)", () => {
    const r = evaluateShowability(URL, [snap({ consoleErrors: ["Failed to load resource: favicon 404"] })]);
    expect(r.pass).toBe(true);
  });

  it("emits a SHADOW fontWarning when a heading falls back to a generic face, WITHOUT failing", () => {
    const r = evaluateShowability(URL, [snap({ checks: okChecks({ headingFontFamily: "serif" }) })]);
    expect(r.pass).toBe(true);
    expect(r.fails).toEqual([]);
    expect(r.fontWarnings).toHaveLength(1);
    expect(r.fontWarnings[0]).toMatch(/heading font resolves to a generic fallback \("serif"\)/);
  });

  it("does NOT warn when a real next/font display face leads the heading stack", () => {
    const r = evaluateShowability(URL, [snap()]);
    expect(r.fontWarnings).toEqual([]);
  });
});

describe("headingFontLooksFallback / firstFontToken", () => {
  it("flags generic-only or empty leading tokens", () => {
    expect(headingFontLooksFallback("serif")).toBe(true);
    expect(headingFontLooksFallback("system-ui, sans-serif")).toBe(true);
    expect(headingFontLooksFallback("-apple-system, BlinkMacSystemFont")).toBe(true);
    expect(headingFontLooksFallback("")).toBe(true);
  });
  it("passes a real named face leading the stack", () => {
    expect(headingFontLooksFallback("__Fraunces_abc, serif")).toBe(false);
    expect(headingFontLooksFallback('"Playfair Display", serif')).toBe(false);
  });
  it("firstFontToken unquotes + trims the leading face", () => {
    expect(firstFontToken('"Playfair Display", serif')).toBe("Playfair Display");
    expect(firstFontToken("  Fraunces , serif")).toBe("Fraunces");
    expect(firstFontToken("")).toBe("");
  });
  it("normalizeFontToken strips per-build next/font hashes so the same font matches across builds", () => {
    expect(normalizeFontToken("__Fraunces_abc123, serif")).toBe("fraunces");
    expect(normalizeFontToken("__Fraunces_xyz789, serif")).toBe("fraunces");
    expect(normalizeFontToken("__Fraunces_abc123")).toEqual(normalizeFontToken("__Fraunces_zzz999"));
    expect(normalizeFontToken("__Inter_Fallback_def456")).toBe("inter");
    expect(normalizeFontToken('"Playfair Display", serif')).toBe("playfair display");
  });
});

describe("evaluateFontParity — two-URL compare (instant vs Render)", () => {
  it("reports parity when both previews lead with the same faces", () => {
    const a = evaluateShowability(URL, [snap()]);
    const b = evaluateShowability(`${URL}-render`, [snap()]);
    const p = evaluateFontParity(a, b);
    expect(p.parity).toBe(true);
    expect(p.mismatches).toEqual([]);
  });

  it("flags a heading-font mismatch across the two previews (the reported symptom)", () => {
    const instant = evaluateShowability(URL, [snap()]);
    const render = evaluateShowability(`${URL}-render`, [
      snap({ checks: okChecks({ headingFontFamily: "serif" }) }),
    ]);
    const p = evaluateFontParity(instant, render);
    expect(p.parity).toBe(false);
    expect(p.mismatches[0]).toMatch(/\[desktop\|\/\] heading font differs/);
  });

  it("does NOT false-flag when the two builds use the SAME font with different next/font hashes", () => {
    const a = evaluateShowability(URL, [
      snap({ checks: okChecks({ headingFontFamily: "__Fraunces_abc123, serif" }) }),
    ]);
    const b = evaluateShowability(`${URL}-render`, [
      snap({ checks: okChecks({ headingFontFamily: "__Fraunces_zzz999, serif" }) }),
    ]);
    expect(evaluateFontParity(a, b).parity).toBe(true);
  });

  it("ignores (viewport,path) renders that aren't present in BOTH runs", () => {
    const a = evaluateShowability(URL, [snap({ path: "/" }), snap({ path: "/about" })]);
    const b = evaluateShowability(`${URL}-render`, [snap({ path: "/" })]);
    const p = evaluateFontParity(a, b);
    expect(p.parity).toBe(true);
  });
});

describe("SHOWABILITY_SENTINEL", () => {
  it("matches un-escaped markup / probe pollution and not clean copy", () => {
    expect(SHOWABILITY_SENTINEL.test("<script>alert(1)</script>")).toBe(true);
    expect(SHOWABILITY_SENTINEL.test("img onerror=alert(1)")).toBe(true);
    expect(SHOWABILITY_SENTINEL.test("see PROBE for details")).toBe(true);
    expect(SHOWABILITY_SENTINEL.test("Browse cars near you and book in minutes")).toBe(false);
  });
});

describe("browserCheckExpr", () => {
  it("is a self-contained arrow-function source string", () => {
    const expr = browserCheckExpr();
    expect(expr.trim().startsWith("()")).toBe(true);
    expect(expr).toContain("getBoundingClientRect");
    expect(expr).toContain("ctaCount");
    expect(expr).toContain("headingFontFamily");
    expect(expr).toContain("bodyFontFamily");
    expect(expr).toContain("getComputedStyle");
  });
});

function fakeChromium(opts: {
  checksFor: (vpWidth: number, target: string) => ShowabilityChecks;
  status?: number;
  gotoThrows?: boolean;
  pageError?: string;
}): { launcher: ChromiumLauncher; navigated: string[] } {
  const navigated: string[] = [];
  let currentWidth = 0;
  let pageErrorCb: ((e: unknown) => void) | null = null;
  const launcher: ChromiumLauncher = {
    async launch() {
      return {
        async newContext(o) {
          currentWidth = o.viewport.width;
          return {
            async newPage() {
              return {
                on(event: string, cb: (arg: never) => void) {
                  if (event === "pageerror") pageErrorCb = cb as (e: unknown) => void;
                },
                async goto(url: string) {
                  navigated.push(url);
                  if (opts.gotoThrows) throw new Error("net::ERR_CONNECTION_REFUSED");
                  if (opts.pageError && pageErrorCb) pageErrorCb(opts.pageError);
                  return { status: () => opts.status ?? 200 };
                },
                async waitForTimeout() {},
                async evaluate() {
                  return opts.checksFor(currentWidth, navigated[navigated.length - 1] ?? "");
                },
              };
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
  return { launcher, navigated };
}

describe("runShowabilityGate — browser runner (injected fake chromium)", () => {
  it("runs every viewport x path and PASSES a clean app", async () => {
    const { launcher, navigated } = fakeChromium({ checksFor: () => okChecks() });
    const r = await runShowabilityGate({ url: URL, paths: ["/", "/search"] }, launcher);
    expect(r.pass).toBe(true);
    expect(r.snapshots).toHaveLength(SHOWABILITY_VIEWPORTS.length * 2);
    expect(navigated).toContain(`${URL}/`);
    expect(navigated).toContain(`${URL}/search`);
  });

  it("FAILS when mobile (375) overflows but desktop is clean", async () => {
    const { launcher } = fakeChromium({
      checksFor: (w) => (w === 375 ? okChecks({ overflow: true, scrollWidth: 520, innerWidth: 375 }) : okChecks()),
    });
    const r = await runShowabilityGate({ url: URL }, launcher);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/\[mobile\/\] horizontal overflow 520>375/);
  });

  it("captures a nav failure as a loadErr FAIL, never throwing", async () => {
    const { launcher } = fakeChromium({ checksFor: () => okChecks(), gotoThrows: true });
    const r = await runShowabilityGate({ url: URL }, launcher);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/load failed/);
  });

  it("FAILS on a runtime pageerror surfaced during load", async () => {
    const { launcher } = fakeChromium({
      checksFor: () => okChecks(),
      pageError: "ReferenceError: foo is not defined",
    });
    const r = await runShowabilityGate({ url: URL }, launcher);
    expect(r.pass).toBe(false);
    expect(r.firstFailure).toMatch(/runtime pageerror: ReferenceError/);
  });

  it("strips a trailing slash from the base url before composing targets", async () => {
    const { launcher, navigated } = fakeChromium({ checksFor: () => okChecks() });
    await runShowabilityGate({ url: `${URL}/` }, launcher);
    expect(navigated.every((u) => u === `${URL}/`)).toBe(true);
  });
});

describe("resolveShowabilityGateMode", () => {
  const orig = process.env.SHOWABILITY_GATE_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.SHOWABILITY_GATE_MODE;
    else process.env.SHOWABILITY_GATE_MODE = orig;
  });

  it("defaults to off", () => {
    delete process.env.SHOWABILITY_GATE_MODE;
    expect(resolveShowabilityGateMode()).toBe("off");
  });
  it("resolves shadow + enforce, case-insensitive", () => {
    process.env.SHOWABILITY_GATE_MODE = "SHADOW";
    expect(resolveShowabilityGateMode()).toBe("shadow");
    process.env.SHOWABILITY_GATE_MODE = "enforce";
    expect(resolveShowabilityGateMode()).toBe("enforce");
  });
  it("treats any unrecognized value as off (fail-safe)", () => {
    process.env.SHOWABILITY_GATE_MODE = "yes-please";
    expect(resolveShowabilityGateMode()).toBe("off");
  });
});
