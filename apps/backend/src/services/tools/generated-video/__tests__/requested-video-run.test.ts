import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; row?: Record<string, unknown> };

const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; filters: Array<[string, string, unknown]>; row?: Record<string, unknown> }>,
  runs: [] as Array<Record<string, unknown>>,
  readError: null as null | { message: string },
  tenants: [] as string[],
}));

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  asTenantId: (id: string) => id,
  tenantClient: (tenantId: string) => {
    db.tenants.push(tenantId);
    return {
      from: (table: string) => {
        const call: Call = { table, op: "select", filters: [] };
        db.calls.push(call);
        const matches = () =>
          db.runs.filter((r) =>
            call.filters.every(([op, col, v]) => {
              const got = col.startsWith("payload->>") ? (r.payload as Record<string, unknown>)?.[col.slice(10)] : r[col];
              return op === "eq" ? got === v : true;
            }),
          );
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string, v: unknown) => {
            call.filters.push(["eq", col, v]);
            return chain;
          },
          limit: () => chain,
          order: () => chain,
          insert: (row: Record<string, unknown>) => {
            call.op = "insert";
            call.row = row;
            db.runs.push({ ...row, tenant_id: tenantId });
            return chain;
          },
          single: async () => ({ data: { id: call.row?.id }, error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            resolve(db.readError ? { data: null, error: db.readError } : { data: matches().map((r) => ({ id: r.id })), error: null }),
        };
        return chain;
      },
    };
  },
}));

import { createRequestedVideoRun, REQUESTED_VIDEO_RUN_STAGE } from "../propose_video";

const inserts = () => db.calls.filter((c) => c.op === "insert");

beforeEach(() => {
  db.calls = [];
  db.runs = [];
  db.readError = null;
  db.tenants = [];
});

describe("createRequestedVideoRun: the holder run a chat-asked video card is filed under", () => {
  it("is stamped as a chat run, so its render charge stays out of the channel's 30-day credit cap", async () => {
    await createRequestedVideoRun("t-1", "chat-run-1");
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.row).toMatchObject({
      agent_slug: "generated_video",
      channel_slug: "generated_video",
      agent_definition_hash: REQUESTED_VIDEO_RUN_STAGE,
      trigger: "chat",
      status: "success",
      payload: { stage: REQUESTED_VIDEO_RUN_STAGE, requested_by_run_id: "chat-run-1" },
    });
    expect(inserts()[0]!.row!.trigger).not.toBe("manual");
  });

  it("a retried tool call from the same chat run reuses the first holder instead of leaving a second one behind", async () => {
    const first = await createRequestedVideoRun("t-1", "chat-run-1");
    const second = await createRequestedVideoRun("t-1", "chat-run-1");
    expect(second).toBe(first);
    expect(inserts()).toHaveLength(1);
    expect(db.runs).toHaveLength(1);
  });

  it("a different chat run gets its own holder", async () => {
    const a = await createRequestedVideoRun("t-1", "chat-run-1");
    const b = await createRequestedVideoRun("t-1", "chat-run-2");
    expect(b).not.toBe(a);
    expect(inserts()).toHaveLength(2);
  });

  it("does not reuse a holder that was marked failed", async () => {
    const first = await createRequestedVideoRun("t-1", "chat-run-1");
    db.runs[0]!.status = "failed";
    const second = await createRequestedVideoRun("t-1", "chat-run-1");
    expect(second).not.toBe(first);
    expect(inserts()).toHaveLength(2);
  });

  it("looks for the prior holder only inside the caller's tenant, by stage and chat run", async () => {
    await createRequestedVideoRun("t-1", "chat-run-1");
    expect(db.tenants.every((t) => t === "t-1")).toBe(true);
    const read = db.calls.find((c) => c.table === "agent_runs" && c.op === "select")!;
    expect(read.filters).toEqual(
      expect.arrayContaining([
        ["eq", "agent_definition_hash", REQUESTED_VIDEO_RUN_STAGE],
        ["eq", "payload->>requested_by_run_id", "chat-run-1"],
      ]),
    );
  });

  it("an unreadable lookup still files a fresh holder rather than failing the request", async () => {
    db.readError = { message: "boom" };
    const id = await createRequestedVideoRun("t-1", "chat-run-1");
    expect(typeof id).toBe("string");
    expect(inserts()).toHaveLength(1);
  });
});
