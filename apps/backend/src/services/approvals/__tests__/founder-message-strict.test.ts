import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, Array<Record<string, unknown>>> = {};
const failing = new Set<string>();
let rpcError: string | null = null;
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((f[c] = v), q),
        maybeSingle: async () =>
          failing.has(table)
            ? { data: null, error: { message: `${table} down` } }
            : { data: (rows[table] ?? []).find((r) => Object.entries(f).every(([k, v]) => r[k] === v)) ?? null, error: null },
      };
      return q;
    },
  }),
  tenantRpc: async () => (rpcError ? { data: null, error: { message: rpcError } } : { data: "user-owner", error: null }),
}));

import { FOUNDER_REF_UNREADABLE, founderMessageOf, founderMessageRefForChild, slackApproverOf } from "../founder-message";
import { stripReservedRunPayloadKeys } from "@/services/agents/reserved-payload";

const T = "t1";
const now = Date.parse("2026-10-18T04:14:00Z");
const root = { id: "run-turn", tenant_id: T, trigger: "chat", enqueued_by: "user-owner", payload: { thread_id: "th", user_message_id: "m1" }, enqueued_at: "2026-10-18T04:13:58Z" };
const msg = { id: "m1", tenant_id: T, sender_role: "user", agent_run_id: "run-turn", body: "okay lets do those changes", created_at: "2026-10-18T04:13:58Z" };
const child = { id: "c1", tenant_id: T, trigger: "handoff", enqueued_by: null, payload: { founder_message_ref: { kind: "chat", id: "m1", author_user_id: "user-owner", run_id: "run-turn" } } };

beforeEach(() => {
  rows.agent_runs = [root];
  rows.agent_thread_messages = [msg];
  failing.clear();
  rpcError = null;
});

describe("founderMessageOf strict", () => {
  it("reads the founder's message either way when nothing fails", async () => {
    expect((await founderMessageOf(child, { now }))?.author_user_id).toBe("user-owner");
    expect((await founderMessageOf(child, { now, strict: true }))?.text).toBe("okay lets do those changes");
  });

  it("must-catch: a failed run or message read throws under strict, and stays null without it", async () => {
    for (const table of ["agent_runs", "agent_thread_messages"]) {
      failing.clear();
      failing.add(table);
      await expect(founderMessageOf(child, { now, strict: true }), table).rejects.toThrow(/read failed/);
      expect(await founderMessageOf(child, { now }), table).toBeNull();
    }
  });

  it("must-catch: a message or root the ref names that is not there throws under strict (unverifiable), and is null without", async () => {
    rows.agent_thread_messages = [];
    await expect(founderMessageOf(child, { now, strict: true })).rejects.toThrow(/not found/);
    expect(await founderMessageOf(child, { now })).toBeNull();
    rows.agent_runs = [];
    await expect(founderMessageOf(child, { now, strict: true })).rejects.toThrow(/not found/);
  });

  it("a stale message is null for the envelope but still read when the age is not asked (the founder marker)", async () => {
    expect(await founderMessageOf(child, { now: now + 3 * 3600_000, strict: true })).toBeNull();
    expect((await founderMessageOf(child, { strict: true, anyAge: true }))?.author_user_id).toBe("user-owner");
  });

  it("must-catch: a root that no longer matches its ref throws under strict, and is null without", async () => {
    rows.agent_runs = [{ ...root, enqueued_by: "user-member" }];
    await expect(founderMessageOf(child, { now, strict: true })).rejects.toThrow(/does not match/);
    expect(await founderMessageOf(child, { now })).toBeNull();
  });

  it("the Slack sender lookup throws on an rpc error under strict only", async () => {
    rpcError = "rpc down";
    await expect(slackApproverOf(T, { team_id: "T9", user: "U1" }, true)).rejects.toThrow(/read failed/);
    expect(await slackApproverOf(T, { team_id: "T9", user: "U1" })).toBeNull();
  });
});

describe("founderMessageRefForChild strict", () => {
  it("must-catch: an unreadable parent throws under strict (the handoff marks the child), null without", async () => {
    failing.add("agent_runs");
    await expect(founderMessageRefForChild(T, "run-turn", { strict: true })).rejects.toThrow();
    expect(await founderMessageRefForChild(T, "run-turn")).toBeNull();
  });

  it("a grandchild of an unreadable child is unreadable too; a readable parent gives its root's ref", async () => {
    rows.agent_runs = [root, { id: "c2", tenant_id: T, trigger: "handoff", enqueued_by: null, payload: { [FOUNDER_REF_UNREADABLE]: true } }];
    await expect(founderMessageRefForChild(T, "c2", { strict: true })).rejects.toThrow(/unreadable/);
    expect(await founderMessageRefForChild(T, "run-turn", { strict: true })).toEqual({ kind: "chat", id: "m1", author_user_id: "user-owner", run_id: "run-turn" });
  });

  it("no client can write the unreadable mark", () => {
    expect(stripReservedRunPayloadKeys({ message: "x", [FOUNDER_REF_UNREADABLE]: true })).toEqual({ message: "x" });
  });
});
