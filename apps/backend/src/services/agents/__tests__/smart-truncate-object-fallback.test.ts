
import { describe, it, expect } from "vitest";
import { smartTruncateToolResult, toolResultCapBytes } from "../smart-truncate";

function seoAuditPayload() {
  return {
    site: "https://www.upcar.ai",
    provenance: "public",
    pages_analyzed: 6,
    findings: [
      { severity: "blocker", id: "spa_shell", page: "/search", detail: "x".repeat(150) },
      { severity: "high", id: "missing_h1", page: "/", detail: "y".repeat(150) },
    ],
    pages: Array.from({ length: 6 }, (_, i) => ({
      url: `/p${i}`,
      title: "t".repeat(120),
      meta: "m".repeat(160),
      h1: "h".repeat(80),
      structured_data: ["Organization", "WebSite"],
    })),
    notes: [] as string[],
  };
}

describe("object fallback — keeps what fits instead of eliding everything", () => {
  const cap = 2048;

  it("keeps the small high-value arrays and elides only the bulk", () => {
    const raw = JSON.stringify(seoAuditPayload());
    expect(Buffer.byteLength(raw)).toBeGreaterThan(cap);

    const out = smartTruncateToolResult(raw, cap);
    const parsed = JSON.parse(out);

    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].id).toBe("spa_shell");
    expect(Array.isArray(parsed.notes)).toBe(true);
    expect(Array.isArray(parsed.pages)).toBe(true);
    expect(parsed.pages.length).toBeGreaterThan(0);
    expect(parsed.pages.length).toBeLessThan(6);
  });

  it("names a partial array with its real total, so the head is never read as the whole", () => {
    const out = smartTruncateToolResult(JSON.stringify(seoAuditPayload()), cap);
    const parsed = JSON.parse(out);
    expect(parsed._partial_fields).toEqual([
      { field: "pages", returned: parsed.pages.length, total: 6 },
    ]);
    expect(parsed._hint).toMatch(/persisted server-side/);
  });

  it("names what it elided when not even one row fits", () => {
    const payload = { site: "a", blobs: [{ big: "x".repeat(3000) }, { big: "y".repeat(3000) }] };
    const parsed = JSON.parse(smartTruncateToolResult(JSON.stringify(payload), cap));
    expect(parsed.blobs).toMatch(/elided/);
    expect(parsed._elided_fields).toContain("blobs");
    expect(parsed._hint).toMatch(/NOT empty/);
  });

  it("stays valid JSON and under the cap", () => {
    const out = smartTruncateToolResult(JSON.stringify(seoAuditPayload()), cap);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(cap);
  });

  it("keeps scalars, which is the behaviour that already worked", () => {
    const out = smartTruncateToolResult(JSON.stringify(seoAuditPayload()), cap);
    const parsed = JSON.parse(out);
    expect(parsed.site).toBe("https://www.upcar.ai");
    expect(parsed.provenance).toBe("public");
    expect(parsed.pages_analyzed).toBe(6);
  });

  it("findings survive even at the bare 2KB default, which is what was broken", () => {
    const parsed = JSON.parse(
      smartTruncateToolResult(JSON.stringify(seoAuditPayload()), 2048),
    );
    expect(parsed.findings?.length ?? 0).toBeGreaterThan(0);
  });

  it("growth_seo_audit's own cap now fits a full crawl, so nothing is elided", () => {
    const realCap = toolResultCapBytes("growth", "seo_audit");
    expect(realCap).toBeGreaterThanOrEqual(16 * 1024);

    const raw = JSON.stringify(seoAuditPayload());
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(realCap);
    const out = smartTruncateToolResult(raw, realCap);
    expect(out).toBe(raw);
    const parsed = JSON.parse(out);
    expect(parsed.pages).toHaveLength(6);
    expect(parsed._truncated).toBeUndefined();
  });

  it("a payload that fits is returned byte-identical", () => {
    const small = JSON.stringify({ site: "a", findings: [{ id: "x" }] });
    expect(smartTruncateToolResult(small, cap)).toBe(small);
  });

  it("falls back to the bare envelope when even the scalars overflow", () => {
    const out = smartTruncateToolResult(
      JSON.stringify({ huge: "z".repeat(400), nested: { a: 1 } }),
      64,
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(512);
  });
});

describe("object fallback — a wide object keeps its scalars", () => {
  function wideObject(fields: number, nameLen: number) {
    const o: Record<string, unknown> = {
      site: "https://www.upcar.ai",
      provenance: "public",
      pages_analyzed: 6,
    };
    for (let i = 0; i < fields; i++) {
      o[`f${i}`.padEnd(nameLen, "x")] = [{ a: "y".repeat(300) }];
    }
    return o;
  }

  for (const [fields, nameLen] of [[19, 8], [15, 16], [10, 40], [24, 8]] as const) {
    it(`keeps scalars with ${fields} nested fields at ${nameLen}-char names`, () => {
      const raw = JSON.stringify(wideObject(fields, nameLen));
      expect(Buffer.byteLength(raw)).toBeGreaterThan(2048);
      const out = smartTruncateToolResult(raw, 2048);
      const p = JSON.parse(out);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
      expect(p.site).toBe("https://www.upcar.ai");
      expect(p.provenance).toBe("public");
      expect(p.pages_analyzed).toBe(6);
      expect(p._total_fields).toBe(fields);
    });
  }

  it("bounds the elided-name list instead of letting it crowd out data", () => {
    const raw = JSON.stringify(wideObject(40, 30));
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2048);
    const out = smartTruncateToolResult(raw, 2048);
    const p = JSON.parse(out);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(p._elided_fields ?? []))).toBeLessThanOrEqual(320);
    expect((p._elided_fields?.length ?? 0) + (p._elided_fields_unnamed ?? 0)).toBe(40);
  });

  it("does not list the names twice", () => {
    const raw = JSON.stringify(wideObject(6, 20));
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2048);
    const out = smartTruncateToolResult(raw, 2048);
    const p = JSON.parse(out);
    const firstName = p._elided_fields[0];
    expect(p._hint).not.toContain(firstName);
  });
});

describe("object fallback — leftover budget is spent, not wasted (2026-09-17)", () => {
  it("a page body string grows past the 200-char preview up to the cap", () => {
    const payload = {
      final_url: "https://example.com/",
      status: 200,
      content_type: "text/html",
      body_text: "word ".repeat(4000),
      capture: "dom_text",
    };
    const out = smartTruncateToolResult(JSON.stringify(payload), 2048);
    const parsed = JSON.parse(out);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
    expect(parsed.body_text.length).toBeGreaterThan(1200);
    expect(parsed.body_text.endsWith("…")).toBe(true);
    expect(parsed.final_url).toBe("https://example.com/");
  });

  it("a search hits array keeps its first hits instead of becoming [elided]", () => {
    const payload = {
      hits: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, body: "b".repeat(500) })),
    };
    const out = smartTruncateToolResult(JSON.stringify(payload), 2048);
    const parsed = JSON.parse(out);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
    expect(Array.isArray(parsed.hits)).toBe(true);
    expect(parsed.hits[0].id).toBe("n0");
    expect(parsed._partial_fields[0]).toMatchObject({ field: "hits", total: 8 });
  });
});
