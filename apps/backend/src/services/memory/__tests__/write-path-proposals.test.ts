import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  ops: [] as Array<{ tid: string; table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }>,
  insertError: null as { message: string; code?: string } | null,
  rows: [] as unknown[],
  prior: null as unknown,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      const rec = { tid, table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, string, unknown]> };
      H.ops.push(rec);
      const b: Record<string, unknown> = {};
      for (const f of ["eq", "in", "is", "order", "limit"]) {
        b[f] = (c: string, v: unknown) => (rec.filters.push([f, c, v]), b);
      }
      b.select = () => b;
      b.insert = (p: unknown) => ((rec.op = "insert"), (rec.payload = p), b);
      b.update = (p: unknown) => ((rec.op = "update"), (rec.payload = p), b);
      b.single = async () => (H.insertError ? { data: null, error: H.insertError } : { data: { id: "prop-new" }, error: null });
      b.maybeSingle = async () => ({ data: H.prior, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: H.rows, error: null });
      return b;
    },
  }),
  tenantRpc: vi.fn(),
}));
vi.mock("../embed", () => ({ embedOne: vi.fn() }));
vi.mock("../index", () => ({ PRIVATE_NOTE_TYPE_SET: new Set() }));

import { insertProposal, loadPendingProposals, markProposalsDecided, proposalKey, MAX_PROPOSALS_PER_RUN } from "../write-path";

const T = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  H.ops = [];
  H.insertError = null;
  H.rows = [];
  H.prior = null;
});

describe("insertProposal", () => {
  it("queues a 'proposed' row in the caller's tenant with the run, text, tags and key", async () => {
    const out = await insertProposal(T, { run_id: RUN, thread_id: null, title: "Take rate", body: "Take rate is 15%.", tags: ["pricing"] });
    expect(out).toEqual({ proposal_id: "prop-new", already_queued: false });
    const ins = H.ops.find((o) => o.op === "insert")!;
    expect(ins.tid).toBe(T);
    expect(ins.table).toBe("memory_write_log");
    expect(ins.payload).toMatchObject({
      action: "proposed",
      source: "memory_write_tool",
      run_id: RUN,
      candidate_title: "Take rate",
      candidate_body: "Take rate is 15%.",
      candidate_tags: ["pricing"],
      tool_call_key: proposalKey("Take rate", "Take rate is 15%."),
    });
  });

  it("the same proposal twice in one run returns the queued row", async () => {
    H.insertError = { message: "duplicate key", code: "23505" };
    H.prior = { id: "prop-old" };
    expect(await insertProposal(T, { run_id: RUN, thread_id: null, title: "t", body: "b", tags: [] })).toEqual({
      proposal_id: "prop-old",
      already_queued: true,
    });
  });

  it("any other insert error throws (the agent is told nothing was queued)", async () => {
    H.insertError = { message: "db down" };
    await expect(insertProposal(T, { run_id: RUN, thread_id: null, title: "t", body: "b", tags: [] })).rejects.toThrow(/db down/);
  });

  it("refuses a non-uuid run id", async () => {
    await expect(insertProposal(T, { run_id: "nope", thread_id: null, title: "t", body: "b", tags: [] })).rejects.toThrow();
  });
});

describe("loadPendingProposals", () => {
  it("reads only this run's undecided proposals, capped, and maps them", async () => {
    H.rows = [
      { id: "p1", candidate_title: "Take rate", candidate_body: "Take rate is 15%.", candidate_tags: ["x"], thread_id: null },
      { id: "p2", candidate_title: null, candidate_body: null, candidate_tags: null },
    ];
    const out = await loadPendingProposals(T, RUN);
    expect(out).toEqual([{ id: "p1", title: "Take rate", body: "Take rate is 15%.", tags: ["x"], thread_id: null }]);
    const q = H.ops[0];
    expect(q.tid).toBe(T);
    expect(q.filters).toEqual(
      expect.arrayContaining([
        ["eq", "run_id", RUN],
        ["eq", "action", "proposed"],
        ["is", "decided_at", null],
        ["limit", MAX_PROPOSALS_PER_RUN, undefined],
      ]),
    );
  });

  it("a non-uuid run id reads nothing", async () => {
    expect(await loadPendingProposals(T, "x")).toEqual([]);
    expect(H.ops).toHaveLength(0);
  });
});

describe("markProposalsDecided", () => {
  it("stamps decided_at on still-pending proposed rows only", async () => {
    await markProposalsDecided(T, ["p1", "p2"]);
    const u = H.ops[0];
    expect(u.op).toBe("update");
    expect(u.payload).toMatchObject({ decided_at: expect.any(String) });
    expect(u.filters).toEqual([
      ["in", "id", ["p1", "p2"]],
      ["eq", "action", "proposed"],
      ["is", "decided_at", null],
    ]);
  });

  it("no ids = no write", async () => {
    await markProposalsDecided(T, []);
    expect(H.ops).toHaveLength(0);
  });
});
