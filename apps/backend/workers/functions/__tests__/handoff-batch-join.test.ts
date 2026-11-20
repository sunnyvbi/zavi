
import { describe, it, expect, vi, beforeEach } from "vitest";

type Child = {
  id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
  raw_response_text: null;
  error: string | null;
  tool_calls: [];
  outcome: null;
  parsed: null;
};

const m = vi.hoisted(() => {
  const state = {
    upserts: [] as Array<{ row: Record<string, unknown>; opts: Record<string, unknown> }>,
    inserts: [] as Record<string, unknown>[],
    rpcPosts: [] as Record<string, unknown>[],
    pushes: [] as Record<string, unknown>[],
    upsertError: null as { message: string } | null,
    rpcError: null as { message: string; code?: string } | null,
    snapshots: [] as Child[][],
    reads: 0,
    parentPending: [] as boolean[],
    pendingChecks: 0,
  };
  const batch = {
    id: "row-1",
    tenant_id: "tenant-1",
    parent_run_id: "parent-run",
    operator_thread_id: "thread-1",
    child_run_ids: ["child-a", "child-b"],
    deadline_at: "",
    status: "pending",
  };
  const from = vi.fn((table: string) => {
    if (table === "handoff_batches") {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: batch, error: null }) };
      return b;
    }
    if (table === "agent_runs") {
      return {
        select: () => ({
          in: async (_c: string, ids: string[]) => {
            const snap = state.snapshots[Math.min(state.reads, state.snapshots.length - 1)];
            state.reads++;
            return { data: snap.filter((c) => ids.includes(c.id)) };
          },
        }),
      };
    }
    if (table === "agent_thread_messages") {
      return {
        upsert: async (row: Record<string, unknown>, opts: Record<string, unknown>) => {
          state.upserts.push({ row, opts });
          return { error: state.upsertError };
        },
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push(row);
          return { error: null };
        },
      };
    }
    if (table === "agent_threads") {
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_handoff_batch") return { data: "row-1", error: null };
    if (name === "record_handoff_chat_message") {
      state.rpcPosts.push(args);
      return { data: "msg", error: state.rpcError };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { state, from, rpc, batch, handler: null as null | ((ctx: unknown) => Promise<unknown>) };
});

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, _trigger: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      m.handler = handler;
      return {};
    },
  },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/agents/handoff-result", () => ({
  PARENT_REPLY_POLL_MS: 3_000,
  PARENT_REPLY_WAIT_MS: 120_000,
  parentReplyPending: async () => {
    m.state.pendingChecks++;
    return m.state.parentPending.shift() ?? false;
  },
  composeHandoffBody: (a: { output_text: string | null; status: string }) =>
    a.status === "success" ? `Done.\n\n${a.output_text}` : "This didn't finish. Nothing was saved. I can try again.",
}));
vi.mock("@/services/agents/delegation-result-schema", () => ({ extractReceipts: () => [] }));
vi.mock("@/services/agents/entitlement", () => ({
  agentDisplayName: (slug: string) =>
    (({ meta_ads: "Meta Ads", google_ads: "Google Ads" }) as Record<string, string>)[slug] ?? slug,
}));
vi.mock("@/services/notifications/push-fanout", () => ({
  notifyThreadOwner: async (a: Record<string, unknown>) => {
    m.state.pushes.push(a);
    return { sent: 1 };
  },
}));

import "../handoff-batch-join";

const child = (id: string, slug: string, status: string, text: string | null = null): Child => ({
  id,
  agent_slug: slug,
  status,
  output_text: text,
  raw_response_text: null,
  error: null,
  tool_calls: [],
  outcome: null,
  parsed: null,
});

let now = 0;
const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
  sleep: async () => {
    now += 15_000;
  },
};
const logger = { warn: vi.fn(), info: vi.fn() };
const run = () => m.handler!({ event: { data: { batch_id: "batch-1" } }, step, logger });

beforeEach(() => {
  Object.assign(m.state, {
    upserts: [],
    inserts: [],
    rpcPosts: [],
    pushes: [],
    upsertError: null,
    rpcError: null,
    snapshots: [],
    reads: 0,
    parentPending: [],
    pendingChecks: 0,
  });
  now = 1_000_000;
  m.batch.deadline_at = new Date(now + 60_000).toISOString();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("handoff-batch-join", () => {
  it("all specialists done in time: one combined post, unbound + idempotent, one push", async () => {
    m.state.snapshots = [[child("child-a", "meta_ads", "success", "40 clicks"), child("child-b", "google_ads", "success", "12 clicks")]];
    const res = (await run()) as { status: string };
    expect(res.status).toBe("synthesized");
    expect(m.state.upserts).toHaveLength(1);
    const { row, opts } = m.state.upserts[0];
    expect(row.agent_run_id).toBeNull();
    expect(row.id).toBe("row-1");
    expect(opts).toMatchObject({ onConflict: "id", ignoreDuplicates: true });
    expect(row.meta).toMatchObject({ parent_run_id: "parent-run", child_run_ids: ["child-a", "child-b"] });
    expect(row.body).toMatch(/^Here's what the specialists found\./);
    expect(row.body).toContain("**Meta Ads**\nDone.\n\n40 clicks");
    expect(row.body).toContain("**Google Ads**\nDone.\n\n12 clicks");
    expect(row.body).not.toMatch(/Parallel handoff|Runs tab|specialist\(s\)|60s/);
    expect(m.state.rpcPosts).toHaveLength(0);
    expect(m.state.pushes).toEqual([
      expect.objectContaining({ thread_id: "thread-1", body: "Your specialists' answers are in." }),
    ]);
  });

  it("waits for the operator's own reply before posting the combined answer", async () => {
    m.state.snapshots = [[child("child-a", "meta_ads", "success", "40 clicks"), child("child-b", "google_ads", "success", "12 clicks")]];
    m.state.parentPending = [true, true];
    const res = (await run()) as { status: string };
    expect(res.status).toBe("synthesized");
    expect(m.state.pendingChecks).toBe(3);
    expect(m.state.upserts).toHaveLength(1);
  });

  it("10-08 case: both still working at 60s, each posts its own answer when it lands, once", async () => {
    const running = [child("child-a", "meta_ads", "running"), child("child-b", "google_ads", "running")];
    const polls = 6;
    m.state.snapshots = [
      ...Array(polls).fill(running),
      [child("child-a", "meta_ads", "running"), child("child-b", "google_ads", "success", "12 clicks")],
      [child("child-a", "meta_ads", "success", "40 clicks")],
    ];
    const res = (await run()) as { status: string; late_posted: number };
    expect(res.status).toBe("timed_out");
    const combined = m.state.upserts[0].row;
    expect(combined.body).toBe(
      "Meta Ads and Google Ads are still working. Each will post its answer here when it's done.",
    );
    expect(combined.meta).toMatchObject({ child_run_ids: [] });
    expect(m.state.rpcPosts.map((p) => p.p_run_id)).toEqual(["child-b", "child-a"]);
    expect(m.state.rpcPosts[0]).toMatchObject({ p_operator_thread_id: "thread-1", p_tenant_id: "tenant-1" });
    expect(m.state.rpcPosts[0].p_body).toBe("**Google Ads**\nDone.\n\n12 clicks");
    expect(m.state.pushes.map((p) => p.body)).toEqual([
      "Google Ads answered your question.",
      "Meta Ads answered your question.",
    ]);
    expect(res.late_posted).toBe(2);
    expect(m.state.inserts).toHaveLength(0);
  });

  it("partial at the deadline: names who is done and who is still working", async () => {
    const snap = [child("child-a", "meta_ads", "running"), child("child-b", "google_ads", "success", "12 clicks")];
    m.state.snapshots = [...Array(6).fill(snap), [child("child-a", "meta_ads", "failed")]];
    await run();
    const body = m.state.upserts[0].row.body as string;
    expect(body.startsWith("Google Ads is done. Meta Ads is still working and will post here when it's ready.")).toBe(true);
    expect(m.state.upserts[0].row.meta).toMatchObject({ child_run_ids: ["child-b"] });
    expect(m.state.rpcPosts).toHaveLength(1);
    expect(m.state.rpcPosts[0].p_body).toMatch(/^\*\*Meta Ads\*\* couldn't finish\./);
  });

  it("a retried late post that already landed (23505) is not an error and does not push twice", async () => {
    m.state.rpcError = { message: "duplicate key", code: "23505" };
    const snap = [child("child-a", "meta_ads", "running"), child("child-b", "google_ads", "success", "x")];
    m.state.snapshots = [...Array(6).fill(snap), [child("child-a", "meta_ads", "success", "y")]];
    await run();
    expect(m.state.rpcPosts).toHaveLength(1);
    expect(m.state.pushes.map((p) => p.body)).toEqual(["Google Ads answered your question."]);
  });

  it("still working after 30 minutes: one plain give-up line", async () => {
    m.state.snapshots = [[child("child-a", "meta_ads", "running"), child("child-b", "google_ads", "running")]];
    await run();
    expect(m.state.inserts).toHaveLength(1);
    expect(m.state.inserts[0].body).toBe(
      "Meta Ads and Google Ads are still working after 30 minutes. Ask me to check on them anytime.",
    );
    expect(m.state.pushes.at(-1)).toMatchObject({ thread_id: "thread-1", body: m.state.inserts[0].body });
  });

  it("throws on a failed combined insert so Inngest retries instead of dropping it", async () => {
    m.state.upsertError = { message: "boom" };
    m.state.snapshots = [[child("child-a", "meta_ads", "success", "a"), child("child-b", "google_ads", "success", "b")]];
    await expect(run()).rejects.toThrow(/post insert error/);
  });
});
