import { describe, expect, it } from "vitest";
import { markSitePrCardsMerged, mergedReceiptLine } from "../site-pr";

const PR = "https://github.com/acme/site/pull/12";

function deps(cards: Array<{ id: string; exec_result: Record<string, unknown> | null }>) {
  const writes: Array<{ id: string; result: Record<string, unknown> }> = [];
  return {
    writes,
    d: {
      readCards: async (_t: string, url: string) => (url === PR ? cards : []),
      writeResult: async (_t: string, id: string, result: Record<string, unknown>) => {
        writes.push({ id, result });
      },
    },
  };
}

describe("mergedReceiptLine", () => {
  it("turns the opened line into a merged one", () => {
    expect(mergedReceiptLine(PR, "Pull request #12 opened on acme/site. Review and merge it on GitHub.")).toBe("Pull request #12 merged on acme/site.");
  });
  it("keeps a repo name with a dot whole", () => {
    expect(mergedReceiptLine(PR, "Pull request #12 opened on acme/next.js. Review and merge it on GitHub.")).toBe("Pull request #12 merged on acme/next.js.");
  });
  it("falls back to the number in the link", () => {
    expect(mergedReceiptLine(PR, null)).toBe("Pull request #12 merged.");
  });
});

describe("markSitePrCardsMerged", () => {
  it("stamps merged_at and the merged receipt, keeping the rest of exec_result", async () => {
    const { d, writes } = deps([{ id: "c1", exec_result: { pr_url: PR, receipt: { line: "Pull request #12 opened on acme/site. Review and merge it on GitHub.", url: PR }, notice: "x" } }]);
    expect(await markSitePrCardsMerged("t1", PR, "2026-11-01T10:00:00Z", d)).toBe(1);
    expect(writes[0]).toEqual({
      id: "c1",
      result: { pr_url: PR, merged_at: "2026-11-01T10:00:00Z", notice: "Pull request #12 merged on acme/site.", receipt: { line: "Pull request #12 merged on acme/site.", url: PR } },
    });
  });
  it("is a no-op on a redelivery", async () => {
    const { d, writes } = deps([{ id: "c1", exec_result: { pr_url: PR, merged_at: "2026-11-01T10:00:00Z" } }]);
    expect(await markSitePrCardsMerged("t1", PR, "2026-11-01T11:00:00Z", d)).toBe(0);
    expect(writes).toEqual([]);
  });
  it("ignores anything that is not a GitHub pull request link", async () => {
    const { d, writes } = deps([{ id: "c1", exec_result: {} }]);
    expect(await markSitePrCardsMerged("t1", "https://evil.example/pull/1", "x", d)).toBe(0);
    expect(await markSitePrCardsMerged("", PR, "x", d)).toBe(0);
    expect(writes).toEqual([]);
  });
});
