import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ queries: [] as unknown[][][], rows: {} as Record<string, unknown[]> }));

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({
    from: () => {
      const calls: unknown[][] = [];
      m.queries.push(calls);
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "not", "in", "is"]) {
        chain[k] = (...a: unknown[]) => (calls.push([k, ...a]), chain);
      }
      chain.limit = async () => {
        const key = calls.some((c) => c[0] === "is") ? "proposed" : calls.some((c) => c[0] === "in" && c[1] === "id") ? "kept" : "made";
        return { data: m.rows[key] ?? [], error: null };
      };
      return chain;
    },
  }),
}));

import { loadRunExecs } from "@/services/channels/channel-actions";
import { asTenantId } from "@/services/tenant-client";

const T = asTenantId("t-1");
const RUN = "11111111-1111-4111-8111-111111111111";
const KEPT = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const row = (id: string) => ({ exec_class: "meta_ads.set_status", exec_payload: { object_id: id } });

beforeEach(() => {
  m.queries = [];
  m.rows = { made: [row("1")], proposed: [row("2")], kept: [row("3")] };
});

describe("loadRunExecs", () => {
  it("a scheduled run reads only its approved/running changes, as before", async () => {
    expect(await loadRunExecs(T, RUN)).toEqual([{ ...row("1"), twin: "made" }]);
    expect(m.queries).toHaveLength(1);
    expect(m.queries[0]).toContainEqual(["in", "exec_status", ["queued", "dispatching", "executed"]]);
  });

  it("a chat turn adds its proposed (pending or snoozed) cards and the cards its tools returned; all matched strictly", async () => {
    const rows = await loadRunExecs(T, RUN, { toolCardIds: [KEPT, "not-a-uuid", "x),or(tenant_id.neq.t-1"] });
    expect(rows).toEqual([
      { ...row("1"), twin: "chat" },
      { ...row("2"), twin: "chat" },
      { ...row("3"), twin: "chat" },
    ]);
    const proposed = m.queries.find((q) => q.some((c) => c[0] === "is"))!;
    expect(proposed).toContainEqual(["in", "status", ["pending", "snoozed"]]);
    const kept = m.queries.find((q) => q.some((c) => c[0] === "in" && c[1] === "id"))!;
    expect(kept).toContainEqual(["in", "id", [KEPT.toLowerCase()]]);
  });

  it("a chat turn with no tool ids reads no kept cards", async () => {
    await loadRunExecs(T, RUN, { toolCardIds: [] });
    expect(m.queries.some((q) => q.some((c) => c[0] === "in" && c[1] === "id"))).toBe(false);
  });
});
