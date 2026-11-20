import { describe, it, expect, vi, beforeEach } from "vitest";

const inspectMock = vi.fn();
vi.mock("../_client", () => ({ urlInspect: (...a: unknown[]) => inspectMock(...a) }));

import { gscInspectUrlTool } from "../inspect_url";

const ctx = { tenant_id: "t-1" } as any;
const wrap = (result: unknown) => ({ site_url: "sc-domain:example.com", result });

beforeEach(() => inspectMock.mockReset());

describe("gscInspectUrlTool", () => {
  it("flags a canonical mismatch — the silent ranking bug", async () => {
    inspectMock.mockResolvedValue(
      wrap({
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          googleCanonical: "https://example.com/pricing",
          userCanonical: "https://example.com/pricing/",
        },
      }),
    );
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/pricing/" })) as any;
    expect(out.index_status.canonical_mismatch).toBe(true);
  });

  it("does not flag a mismatch when both canonicals agree", async () => {
    inspectMock.mockResolvedValue(
      wrap({ indexStatusResult: { googleCanonical: "https://example.com/x", userCanonical: "https://example.com/x" } }),
    );
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/x" })) as any;
    expect(out.index_status.canonical_mismatch).toBe(false);
  });

  it("does not invent a mismatch when Google reports only one canonical", async () => {
    inspectMock.mockResolvedValue(wrap({ indexStatusResult: { googleCanonical: "https://example.com/x" } }));
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/x" })) as any;
    expect(out.index_status.canonical_mismatch).toBe(false);
    expect(out.index_status.user_canonical).toBeNull();
  });

  it("surfaces the structured data GOOGLE parsed, with its issues", async () => {
    inspectMock.mockResolvedValue(
      wrap({
        richResultsResult: {
          verdict: "PARTIAL",
          detectedItems: [
            {
              richResultType: "Product",
              items: [{ name: "Widget", issues: [{ issueMessage: "Missing field 'price'", severity: "ERROR" }] }],
            },
            { richResultType: "Breadcrumbs", items: [{ name: "Trail" }] },
          ],
        },
      }),
    );
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/p" })) as any;
    expect(out.rich_results.detected_types).toEqual(["Product", "Breadcrumbs"]);
    expect(out.rich_results.detected[0].issues[0]).toMatchObject({
      item: "Widget",
      severity: "ERROR",
      message: "Missing field 'price'",
    });
  });

  it("returns an EMPTY detected list — a citable negative, unlike a static fetch", async () => {
    inspectMock.mockResolvedValue(wrap({ richResultsResult: { verdict: "NEUTRAL" } }));
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/p" })) as any;
    expect(out.rich_results.detected_types).toEqual([]);
    expect(out.rich_results.verdict).toBe("NEUTRAL");
  });

  it("carries last_crawl_time and the staleness caveat", async () => {
    inspectMock.mockResolvedValue(wrap({ indexStatusResult: { lastCrawlTime: "2026-08-30T04:12:00Z" } }));
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/p" })) as any;
    expect(out.index_status.last_crawl_time).toBe("2026-08-30T04:12:00Z");
    expect(out.caveat).toMatch(/last_crawl_time/);
  });

  it("survives an empty inspection result without throwing", async () => {
    inspectMock.mockResolvedValue(wrap({}));
    const out = (await gscInspectUrlTool.execute(ctx, { url: "https://example.com/p" })) as any;
    expect(out.index_status.verdict).toBeNull();
    expect(out.rich_results.detected).toEqual([]);
    expect(out.mobile_usability.issues).toEqual([]);
  });

  it("passes the URL and language through, and rejects a non-URL", async () => {
    inspectMock.mockResolvedValue(wrap({}));
    await gscInspectUrlTool.execute(ctx, { url: "https://example.com/p", language_code: "de-DE" });
    expect(inspectMock).toHaveBeenCalledWith("t-1", "https://example.com/p", "de-DE");

    inspectMock.mockClear();
    await expect(gscInspectUrlTool.execute(ctx, { url: "not-a-url" })).rejects.toThrow();
    expect(inspectMock).not.toHaveBeenCalled();
  });
});
