import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  select: {} as Record<string, Array<Array<Record<string, unknown>>>>,
  deletes: [] as Array<{ table: string; ids: string[] }>,
  purge: vi.fn(),
  finish: vi.fn(),
  search: vi.fn(),
  reviews: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      let del = false;
      const b: Record<string, unknown> = {};
      for (const f of ["select", "eq", "neq", "lt", "lte", "gte", "is", "or", "order", "limit"]) b[f] = () => b;
      b.delete = () => ((del = true), b);
      b.in = (_c: string, ids: string[]) => {
        if (del) H.deletes.push({ table, ids });
        return b;
      };
      b.then = (res: (v: unknown) => unknown) => {
        if (del) return res({ error: null });
        const pages = H.select[table] ?? [];
        return res({ data: pages.shift() ?? [], error: null });
      };
      return b;
    },
  }),
}));
vi.mock("@/services/memory", () => ({ finishPendingNote: H.finish, searchMemory: H.search }));
vi.mock("@/services/memory/remembered", () => ({ purgeForgetRequest: H.purge }));
vi.mock("@/services/logging/log-review", () => ({ logReview: (r: Record<string, unknown>) => H.reviews.push(r) }));

import {
  sweepDueForgets,
  sweepPendingEnrichment,
  runRetention,
  runWriteCanaries,
} from "../memory-write-maintenance";

beforeEach(() => {
  H.select = {};
  H.deletes = [];
  H.purge.mockReset();
  H.finish.mockReset();
  H.search.mockReset();
  H.reviews = [];
});

describe("memory write maintenance", () => {
  it("purges each due Forget with the tenant from its own row", async () => {
    H.select.memory_forget_request = [[{ id: "r1", tenant_id: "t1" }, { id: "r2", tenant_id: "t2" }]];
    H.purge.mockResolvedValueOnce("purged").mockResolvedValueOnce("retry");
    expect(await sweepDueForgets()).toEqual({ purged: 1, retry: 1 });
    expect(H.purge.mock.calls).toEqual([["t1", "r1"], ["t2", "r2"]]);
  });

  it("finishes pending notes with the tenant from the note row and flags failures", async () => {
    H.select.memory_note = [[{ id: "n1", tenant_id: "t1" }, { id: "n2", tenant_id: "t1" }]];
    H.finish.mockResolvedValueOnce("done").mockResolvedValueOnce("failed");
    expect(await sweepPendingEnrichment()).toEqual({ done: 1, pending: 0, failed: 1 });
    expect(H.finish.mock.calls[0]).toEqual(["t1", "n1"]);
    expect(H.reviews[0]).toMatchObject({ feature: "memory_write", event: "enrichment", outcome: "failed" });
  });

  it("retention deletes in bounded batches until a short page", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}` }));
    H.select.memory_note = [full, [{ id: "last" }]];
    H.select.memory_write_log = [[]];
    H.select.memory_forget_request = [[{ id: "f1" }]];
    expect(await runRetention()).toEqual({ task_cards: 501, write_log: 0, forget_requests: 1 });
    expect(H.deletes.map((d) => [d.table, d.ids.length])).toEqual([
      ["memory_note", 500],
      ["memory_note", 1],
      ["memory_forget_request", 1],
    ]);
  });

  it("canaries: reranked synthetic searches, one verdict per update and one abstention per tenant", async () => {
    H.select.memory_write_log = [[{ tenant_id: "t1", note_id: "new", matched_note_id: "old", candidate_title: "Launch month" }]];
    H.search
      .mockResolvedValueOnce([{ note_id: "new", score: 0.9 }])
      .mockResolvedValueOnce([{ note_id: "x", score: 0.1 }]);
    expect(await runWriteCanaries()).toEqual({ update_pass: 1, update_fail: 0, abstain_pass: 1, abstain_fail: 0 });
    for (const call of H.search.mock.calls) expect(call[3]).toEqual({ benchOverride: { reranker: true } });
    expect(H.reviews.map((r) => [r.event, r.outcome])).toEqual([
      ["knowledge_update", "pass"],
      ["abstention", "pass"],
    ]);
  });
});
