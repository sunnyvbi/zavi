
import { describe, it, expect } from "vitest";
import {
  renderDeckInputSchema,
  resolveLayout,
  MAX_SLIDES,
  DECK_PROSE_BUDGET,
} from "../deck-schema";
import { renderDeckHtml, renderSlideBody, esc } from "../render-deck-html";
import { renderDeckPdf } from "../render-deck-pdf";

const slide = (over: Record<string, unknown> = {}) => ({ heading: "A claim", ...over });
const deck = (over: Record<string, unknown> = {}) => ({
  title: "Q3 growth review",
  slides: [slide()],
  filename: "deck",
  ...over,
});

describe("deck-schema", () => {
  it("accepts a minimal deck", () => {
    expect(renderDeckInputSchema.parse(deck()).slides).toHaveLength(1);
  });

  it("rejects zero slides", () => {
    expect(() => renderDeckInputSchema.parse(deck({ slides: [] }))).toThrow();
  });

  it(`rejects more than ${MAX_SLIDES} slides`, () => {
    const slides = Array.from({ length: MAX_SLIDES + 1 }, () => slide());
    expect(() => renderDeckInputSchema.parse(deck({ slides }))).toThrow();
  });

  it(`accepts exactly ${MAX_SLIDES} slides`, () => {
    const slides = Array.from({ length: MAX_SLIDES }, () => slide());
    expect(renderDeckInputSchema.parse(deck({ slides })).slides).toHaveLength(MAX_SLIDES);
  });

  it("rejects a deck over the prose budget even when the slide count is legal", () => {
    const fat = Array.from({ length: MAX_SLIDES }, () => ({
      heading: "x".repeat(120),
      subheading: "y".repeat(200),
      body: "z".repeat(600),
      notes: "n".repeat(400),
      bullets: Array.from({ length: 8 }, () => "b".repeat(200)),
    }));
    const total =
      fat.length * (120 + 200 + 600 + 400 + 8 * 200) + "Q3 growth review".length;
    expect(total).toBeGreaterThan(DECK_PROSE_BUDGET);
    expect(() => renderDeckInputSchema.parse(deck({ slides: fat }))).toThrow(
      /budget/i,
    );
  });

  it("rejects a two_column slide that does not have exactly two columns", () => {
    const one = [{ heading: "H", bullets: ["a"] }];
    expect(() =>
      renderDeckInputSchema.parse(deck({ slides: [slide({ columns: one })] })),
    ).toThrow();
  });

  it("rejects more than 4 metrics", () => {
    const metrics = Array.from({ length: 5 }, (_, i) => ({ value: `${i}`, label: "l" }));
    expect(() =>
      renderDeckInputSchema.parse(deck({ slides: [slide({ metrics })] })),
    ).toThrow();
  });
});

describe("resolveLayout", () => {
  it("honours an explicit layout over inference", () => {
    expect(resolveLayout({ heading: "h", layout: "statement", bullets: ["a"] }, 3)).toBe(
      "statement",
    );
  });
  it("infers title for slide 0 with no content fields", () => {
    expect(resolveLayout({ heading: "h" }, 0)).toBe("title");
  });
  it("infers statement for a later bare slide", () => {
    expect(resolveLayout({ heading: "h" }, 4)).toBe("statement");
  });
  it("infers bullets, metrics and two_column from the payload", () => {
    expect(resolveLayout({ heading: "h", bullets: ["a"] }, 1)).toBe("bullets");
    expect(resolveLayout({ heading: "h", metrics: [{ value: "1", label: "l" }] }, 1)).toBe(
      "metrics",
    );
    expect(
      resolveLayout(
        {
          heading: "h",
          columns: [
            { heading: "A", bullets: ["a"] },
            { heading: "B", bullets: ["b"] },
          ],
        },
        1,
      ),
    ).toBe("two_column");
  });
  it("prefers columns over bullets when both are present", () => {
    expect(
      resolveLayout(
        {
          heading: "h",
          bullets: ["x"],
          columns: [
            { heading: "A", bullets: ["a"] },
            { heading: "B", bullets: ["b"] },
          ],
        },
        1,
      ),
    ).toBe("two_column");
  });
});

describe("renderDeckHtml", () => {
  it("produces one self-contained document with a section per slide", () => {
    const html = renderDeckHtml(
      deck({ slides: [slide(), slide({ bullets: ["one", "two"] }), slide()] }),
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/class="slide"/g) ?? []).length).toBe(3);
    expect(html).toContain("1 / 3");
    expect(html).toContain("3 / 3");
  });

  it("loads nothing external — no remote src/href, no fetch", () => {
    const html = renderDeckHtml(
      deck({ slides: [slide({ bullets: ["a"] }), slide({ metrics: [{ value: "9", label: "l" }] })] }),
    );
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest/);
    expect(html).not.toMatch(/@import/);
  });

  it("escapes model copy so it cannot inject markup", () => {
    const html = renderDeckHtml(
      deck({
        title: "T",
        slides: [
          slide({
            heading: `<img src=x onerror="alert(1)">`,
            bullets: [`</ul><script>alert(2)</script>`],
          }),
        ],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes the five entity characters", () => {
    expect(esc(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("hides notes by default and only renders them when present", () => {
    const html = renderDeckHtml(
      deck({ slides: [slide({ notes: "say the thing" })] }),
    );
    expect(html).toContain('class="notes" hidden');
    expect(html).toContain("say the thing");
  });

  it("renders each layout's distinguishing markup", () => {
    expect(renderSlideBody({ heading: "H" }, 0)).toContain("eyebrow");
    expect(renderSlideBody({ heading: "H", bullets: ["a"] }, 1)).toContain("<li>a</li>");
    expect(
      renderSlideBody({ heading: "H", metrics: [{ value: "38%", label: "churn" }] }, 1),
    ).toContain("38%");
    expect(
      renderSlideBody(
        {
          heading: "H",
          columns: [
            { heading: "Now", bullets: ["a"] },
            { heading: "Next", bullets: ["b"] },
          ],
        },
        1,
      ),
    ).toContain('class="cols"');
  });

  it("throws on invalid input rather than emitting a broken deck", () => {
    expect(() => renderDeckHtml({ title: "t" })).toThrow();
  });
});

describe("renderDeckPdf", () => {
  it("emits a PDF with one page per slide", async () => {
    const bytes = await renderDeckPdf(
      deck({
        subtitle: "the quarter in five slides",
        footer: "Acme — confidential",
        slides: [
          slide({ layout: "title", heading: "Q3 growth review" }),
          slide({ bullets: ["one", "two", "three"] }),
          slide({ metrics: [{ value: "38%", label: "of signups never list" }] }),
          slide({
            columns: [
              { heading: "Now", bullets: ["a", "b"] },
              { heading: "Next", bullets: ["c"] },
            ],
          }),
          slide({ layout: "statement", heading: "Supply is the constraint." }),
        ],
      }),
    );
    const buf = Buffer.from(bytes);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(buf.byteLength).toBeGreaterThan(1000);
    const pages = (buf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBe(5);
  });

  it("uses a 16:9 landscape page box (960 x 540)", async () => {
    const buf = Buffer.from(await renderDeckPdf(deck()));
    expect(buf.toString("latin1")).toContain("/MediaBox [0 0 960 540]");
  });

  it("survives characters pdfkit's WinAnsi fonts cannot draw", async () => {
    const buf = Buffer.from(
      await renderDeckPdf(
        deck({
          slides: [slide({ heading: "Growth ≥ 20% 🚀 →", bullets: ["✓ done", "— dash — ok"] })],
        }),
      ),
    );
    expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("throws on invalid input", async () => {
    await expect(renderDeckPdf({ title: "t", slides: [] })).rejects.toThrow();
  });
});
