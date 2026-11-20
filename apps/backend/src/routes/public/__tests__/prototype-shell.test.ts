
import { describe, it, expect, vi } from "vitest";

const svc = vi.hoisted(() => vi.fn());
vi.mock("@/services/supabase", () => ({ serviceClient: svc }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));

import { esc, renderShell, renderWireframeShell } from "../prototype";
import { htmlPreviewSchema } from "@/agents/engineer/output-schema";

const baseEnv = htmlPreviewSchema.parse({
  kind: "html_preview",
  title: "Hero redesign",
  summary: "Bigger headline.",
  html: "<html><h1>after</h1></html>",
});

describe("renderWireframeShell (variant:wireframe chrome)", () => {
  const wf = htmlPreviewSchema.parse({
    kind: "html_preview",
    variant: "wireframe",
    title: "Booking flow",
    summary: "Pick a car, confirm, pay.",
    html: "<html><button id='b'>Book</button><h2>seats</h2></html>",
    rationale: [{ change: "One-tap book", why: "Fewer steps" }],
  });

  it("renders the wireframe html ONLY inside a sandboxed opaque-origin iframe", () => {
    const out = renderWireframeShell(wf);
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).not.toContain("allow-same-origin");
    expect(out).not.toContain("<h2>seats</h2>");
    expect(out).toContain("&lt;h2&gt;seats&lt;/h2&gt;");
  });

  it("renders NO PR badge and NO 'pull request' footer (invariant #4)", () => {
    const out = renderWireframeShell(wf);
    expect(out.toLowerCase()).not.toContain("pull request");
    expect(out).not.toContain("badge merged");
    expect(out).not.toContain("Ships as real PR");
    expect(out).not.toContain("awaiting owner approval");
  });

  it("labels the page a simulated-data prototype + shows title/summary/rationale", () => {
    const out = renderWireframeShell(wf);
    expect(out).toContain("Booking flow");
    expect(out).toContain("Pick a car, confirm, pay.");
    expect(out.toLowerCase()).toContain("simulated data");
    expect(out).toContain("One-tap book");
  });

  it("a malicious wireframe title cannot break out of the trusted shell", () => {
    const evil = htmlPreviewSchema.parse({
      kind: "html_preview",
      variant: "wireframe",
      title: `"><script>alert(1)</script>`,
      summary: "s",
      html: "<html></html>",
    });
    const out = renderWireframeShell(evil);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("esc", () => {
  it("escapes attribute-breakout characters + U+2028/9", () => {
    expect(esc(`"><script>alert(1)</script>`)).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(esc("a b c")).toBe("a&#8232;b&#8233;c");
    expect(esc(`it's & "q"`)).toBe("it&#39;s &amp; &quot;q&quot;");
  });
});

describe("renderShell trust boundary", () => {
  it("renders generated html ONLY inside a sandboxed srcdoc iframe", () => {
    const out = renderShell(baseEnv, { state: "awaiting_approval" });
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).not.toContain("allow-same-origin");
    expect(out).not.toContain("<h1>after</h1>");
    expect(out).toContain("&lt;h1&gt;after&lt;/h1&gt;");
  });

  it("a malicious envelope cannot break out of srcdoc or fake the badge", () => {
    const evil = htmlPreviewSchema.parse({
      kind: "html_preview",
      title: `"><span class="badge merged">Shipped ✓</span>`,
      summary: `</iframe><script>top.document.title='owned'</script>`,
      html: `"><iframe src=x onload=alert(1)>`,
    });
    const out = renderShell(evil, { state: "awaiting_approval" });
    expect(out).not.toContain("</iframe><script>");
    expect(out).not.toContain("onload=alert(1)>");
    expect(out).toContain("Real PR: awaiting owner approval");
    expect(out).not.toContain('<span class="badge merged">Shipped');
  });

  it("badge states: awaiting / opened / merged", () => {
    expect(renderShell(baseEnv, { state: "awaiting_approval" })).toContain(
      "Real PR: awaiting owner approval",
    );
    const opened = renderShell(baseEnv, {
      state: "opened",
      pr_number: 42,
      pr_url: "https://github.com/x/y/pull/42",
    });
    expect(opened).toContain("Ships as real PR #42 — open");
    expect(opened).toContain('href="https://github.com/x/y/pull/42"');
    expect(
      renderShell(baseEnv, {
        state: "merged",
        pr_number: 42,
        pr_url: "https://github.com/x/y/pull/42",
      }),
    ).toContain("Shipped as real PR #42 ✓");
  });

  it("Before/After toggle renders only when html_before is present", () => {
    const withBefore = htmlPreviewSchema.parse({
      ...baseEnv,
      html_before: "<html><h1>before</h1></html>",
      rationale: [{ change: "Bigger headline", why: "Scannability" }],
    });
    const out = renderShell(withBefore, { state: "awaiting_approval" });
    expect(out).toContain("Before (current)");
    expect(out).toContain("After (proposed)");
    expect(out).toContain("approximate rendering of the current UI");
    expect(out).toContain("Bigger headline");
    const solo = renderShell(baseEnv, { state: "awaiting_approval" });
    expect(solo).not.toContain("Before (current)");
    expect(solo).not.toContain('class="cards"');
  });

  it("prototype-vs-production label always present", () => {
    expect(renderShell(baseEnv, { state: "awaiting_approval" })).toContain(
      "Prototype — not the live app",
    );
  });
});

describe("renderSharedPageShell (operator render_artifact pages)", () => {
  it("renders the page only inside a sandboxed srcdoc iframe with the CSP pinned", async () => {
    const { renderSharedPageShell } = await import("../prototype");
    const out = renderSharedPageShell(`Q3 "review"`, `<h1>Q3</h1><script>alert(1)</script>`);
    const frame = out.match(/<iframe[^>]*>/)![0];
    expect(frame).toContain('sandbox="allow-scripts" ');
    expect(out).not.toMatch(/<script>alert/);
    expect(frame).toContain("&lt;meta http-equiv=&quot;Content-Security-Policy&quot;");
    expect(out).toContain("<title>Q3 &quot;review&quot;</title>");
    expect(out).toContain("Anyone with this link can open this page.");
    expect(out).toContain('name="robots" content="noindex, noarchive, nofollow"');
  });
});

describe("renderSharedPageShell link preview + signup link (2026-10-29)", () => {
  it("adds escaped og/twitter tags from the page's description and links Made with Zavi to signup", async () => {
    const { renderSharedPageShell } = await import("../prototype");
    const out = renderSharedPageShell(
      `Q3 "<b>x</b>"`,
      `<html><head><meta name="description" content="Bookings &quot;fell&quot; &lt;script&gt;alert(1)&lt;/script&gt;"></head><body>x</body></html>`,
    );
    expect(out).toContain('<meta property="og:title" content="Q3 &quot;&lt;b&gt;x&lt;/b&gt;&quot;">');
    expect(out).toContain('<meta property="og:description" content="Bookings &quot;fell&quot; &lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(out).toContain('<meta name="twitter:card" content="summary">');
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toContain('href="https://www.zaviagent.com/signup?utm_source=shared_report"');
    expect(out).toContain('name="robots" content="noindex, noarchive, nofollow"');
    expect(out).toContain('sandbox="allow-scripts" ');
  });

  it("strips report markers (old pages carried the card id) and ignores meta text inside a script", async () => {
    const { renderSharedPageShell, sharedPageDescription } = await import("../prototype");
    const id = "5cf0d32f-2cef-4017-8eb7-21b0f39a3271";
    const out = renderSharedPageShell("t", `<!doctype html><!--zavi-report:${id}--><html><body>Hi</body></html>`);
    expect(out).not.toContain(id);
    expect(sharedPageDescription(`<head><script>var s='<meta name="description" content="secret">'</script></head><body>Shown</body>`)).toBe("Shown");
    expect(sharedPageDescription(`<head><script><meta name="description" content="secret"></head><body>x`)).toBe("x");
    expect(sharedPageDescription(`<head><script></scripture><meta name="description" content="secret"></head><body>x`)).toBe("x");
    expect(sharedPageDescription(`<head><script></script\u00a0><meta name="description" content="secret"></head><body>x`)).toBe("x");
    const t0 = Date.now();
    sharedPageDescription(`${"<script>".repeat(5_000)}${"<svg>".repeat(5_000)}<body>${"<svg>".repeat(40_000)}${"<".repeat(40_000)}`);
    sharedPageDescription(`${"<script x>".repeat(3_000)}<body>y`);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("falls back to the page's visible text, capped, without script or style text", async () => {
    const { sharedPageDescription } = await import("../prototype");
    const d = sharedPageDescription(
      `<head><style>body{x}</style></head><body><script>var secret=1</script><h1>Hello</h1><p>${"word ".repeat(80)}</p></body>`,
    );
    expect(d.startsWith("Hello word")).toBe(true);
    expect(d).not.toMatch(/secret|body\{/);
    expect(d.length).toBeLessThanOrEqual(150);
  });
});

describe("publicPrototypePage serving a shared page", () => {
  it("sends frame-src 'none' so the page cannot navigate itself off-site", async () => {
    const T = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const P = "22222222-2222-4222-2222-222222222222";
    svc.mockReturnValue({
      rpc: async (name: string) =>
        name === "get_prototype_link_by_slug"
          ? { data: [] }
          : { data: [{ tenant_id: T, title: "Q3", storage_path: `${T}/${P}.html` }] },
      storage: { from: () => ({ download: async () => ({ data: { text: async () => "<h1>Q3</h1>" }, error: null }) }) },
    });
    const { publicPrototypePage, SHARED_PAGE_SHELL_CSP } = await import("../prototype");
    const headers: Record<string, string> = {};
    let body = "";
    let status = 0;
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      status: (c: number) => ((status = c), res),
      type: () => res,
      send: (b: string) => ((body = b), res),
    };
    await publicPrototypePage(
      { params: { slug: "A".repeat(22) }, headers: {}, ip: "1.1.1.1" } as never,
      res as never,
    );
    expect(status).toBe(200);
    expect(headers["Content-Security-Policy"]).toBe(SHARED_PAGE_SHELL_CSP);
    expect(SHARED_PAGE_SHELL_CSP).toContain("frame-src 'none'");
    expect(body).toContain("&lt;h1&gt;Q3&lt;/h1&gt;");
  });
});
