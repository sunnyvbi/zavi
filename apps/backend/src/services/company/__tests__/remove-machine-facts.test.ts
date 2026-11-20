
import { describe, it, expect, vi, beforeEach } from "vitest";

type FactRow = { key: string; source: string; source_ref: string };
const h = vi.hoisted(() => ({
  rows: [] as FactRow[],
  calls: [] as unknown[],
  regenerate: vi.fn(),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: (table: string) => {
      h.calls.push(["from", table]);
      const filters: Array<(r: FactRow) => boolean> = [];
      const likeToRe = (p: string) =>
        new RegExp(`^${p.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      const q: Record<string, any> = {
        delete: () => { h.calls.push(["delete"]); return q; },
        in: (c: keyof FactRow, v: string[]) => { h.calls.push(["in", c, v]); filters.push((r) => v.includes(r[c])); return q; },
        eq: (c: keyof FactRow, v: string) => { h.calls.push(["eq", c, v]); filters.push((r) => r[c] === v); return q; },
        like: (c: keyof FactRow, v: string) => { h.calls.push(["like", c, v]); filters.push((r) => likeToRe(v).test(r[c])); return q; },
        select: async () => {
          const hit = h.rows.filter((r) => filters.every((f) => f(r)));
          h.rows = h.rows.filter((r) => !hit.includes(r));
          return { data: hit.map((r) => ({ key: r.key })), error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("../brief", () => ({ regenerateCompanyBrief: h.regenerate }));

import { removeMachineFactsFromSource } from "../facts";

const DOC = "tenant_document:d1#";

beforeEach(() => {
  h.calls = [];
  h.regenerate.mockReset();
  h.rows = [
    { key: "industry", source: "onboarding_enrichment", source_ref: `${DOC}L9~c1` },
    { key: "markets", source: "onboarding_enrichment", source_ref: `${DOC}L9~c1` },
    { key: "location", source: "ai_estimated", source_ref: `${DOC}L90~c1` },
    { key: "who_we_serve", source: "human_confirmed", source_ref: `${DOC}L4~c1` },
    { key: "founded", source: "onboarding_enrichment", source_ref: "tenant_document:d2#L1~c9" },
  ];
});

describe("removeMachineFactsFromSource", () => {
  it("deletes only machine-sourced rows (onboarding_enrichment, ai_estimated)", async () => {
    await removeMachineFactsFromSource("t1", { prefix: DOC });
    expect(h.calls).toContainEqual(["from", "tenant_fact"]);
    expect(h.calls).toContainEqual(["in", "source", ["onboarding_enrichment", "ai_estimated"]]);
  });

  it("a whole file: like 'tenant_document:<id>#%'; human_confirmed and other files survive", async () => {
    const n = await removeMachineFactsFromSource("t1", { prefix: DOC });
    expect(h.calls).toContainEqual(["like", "source_ref", `${DOC}%`]);
    expect(n).toBe(3);
    expect(h.rows.map((r) => r.key).sort()).toEqual(["founded", "who_we_serve"]);
    expect(h.regenerate).toHaveBeenCalledWith("t1");
  });

  it("one read: prefix + claim suffix", async () => {
    await removeMachineFactsFromSource("t1", { prefix: DOC, suffix: "~c1" });
    expect(h.calls).toContainEqual(["like", "source_ref", `${DOC}%~c1`]);
  });

  it("one fact: exact source_ref AND key, so #L90 and another key on the same line survive", async () => {
    const n = await removeMachineFactsFromSource("t1", { exact: `${DOC}L9~c1`, key: "industry" });
    expect(h.calls).toContainEqual(["eq", "source_ref", `${DOC}L9~c1`]);
    expect(h.calls).toContainEqual(["eq", "key", "industry"]);
    expect(n).toBe(1);
    expect(h.rows.map((r) => r.key).sort()).toEqual(["founded", "location", "markets", "who_we_serve"]);
  });

  it("nothing removed: no brief re-render", async () => {
    expect(await removeMachineFactsFromSource("t1", { exact: `${DOC}L4~c1`, key: "who_we_serve" })).toBe(0);
    expect(h.regenerate).not.toHaveBeenCalled();
  });
});
