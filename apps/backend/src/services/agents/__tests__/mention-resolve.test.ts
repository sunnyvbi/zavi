
import { describe, it, expect, vi } from "vitest";
import { pinMentionOnRun, resolveMention, type MentionPinDb } from "../mention";

const TENANT = "11111111-1111-4111-8111-111111111111";
const never = vi.fn(async () => {
  throw new Error("custom lookup must not run");
});

describe("resolveMention", () => {
  it("resolves a channel first, as before", async () => {
    const m = await resolveMention("@meta ads why is CPA up?", TENANT, { isActiveCustom: never });
    expect(m).toEqual({ kind: "channel", agent_slug: "meta_ads", intent: "why is CPA up?" });
  });

  it("resolves Your CGO by either label", async () => {
    for (const msg of ["@Your CGO what's holding my growth back?", "@cgo what's holding my growth back?"]) {
      expect(await resolveMention(msg, TENANT, { isActiveCustom: never })).toEqual({
        kind: "agent",
        agent_slug: "cgo",
        intent: "what's holding my growth back?",
      });
    }
  });

  it("resolves engineer and supply & demand", async () => {
    expect((await resolveMention("@engineer fix the login bug", TENANT))?.agent_slug).toBe("engineer");
    expect((await resolveMention("@supply & demand where are we short?", TENANT))?.agent_slug).toBe("supply-demand-balancer");
  });

  it("does not make page-less helpers mentionable", async () => {
    for (const msg of ["@pm write a spec", "@qa test it", "@support-lead triage", "@operator hi"]) {
      expect(await resolveMention(msg, TENANT, { isActiveCustom: never })).toBeNull();
    }
  });

  it("resolves a custom agent only when it is active in THIS tenant", async () => {
    const lookup = vi.fn(async (tenant: string, slug: string) => tenant === TENANT && slug === "c-ab12cd34");
    expect(await resolveMention("@c-ab12cd34 draft the weekly post", TENANT, { isActiveCustom: lookup })).toEqual({
      kind: "custom",
      agent_slug: "c-ab12cd34",
      intent: "draft the weekly post",
    });
    expect(lookup).toHaveBeenCalledWith(TENANT, "c-ab12cd34");
    expect(await resolveMention("@c-zz99zz99 draft it", TENANT, { isActiveCustom: lookup })).toBeNull();
  });

  it("never looks up a token that is not a custom slug", async () => {
    expect(await resolveMention("@nobody hello", TENANT, { isActiveCustom: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it("treats a bare address or a mid-sentence one as no mention", async () => {
    expect(await resolveMention("@cgo", TENANT)).toBeNull();
    expect(await resolveMention("ask @cgo about it", TENANT)).toBeNull();
    const lookup = vi.fn(async () => true);
    expect(await resolveMention("@c-ab12cd34   ", TENANT, { isActiveCustom: lookup })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

function fakeDb(read: { data: { payload?: unknown } | null; error: { message: string } | null }, writeErr: { message: string } | null = null) {
  const writes: Array<{ row: Record<string, unknown>; eqs: Array<[string, string]> }> = [];
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => read }) }) }),
      update: (row: Record<string, unknown>) => {
        const eqs: Array<[string, string]> = [];
        writes.push({ row, eqs });
        return {
          eq: (c: string, v: string) => {
            eqs.push([c, v]);
            return {
              eq: async (c2: string, v2: string) => {
                eqs.push([c2, v2]);
                return { error: writeErr };
              },
            };
          },
        };
      },
    }),
  } as unknown as MentionPinDb;
  return { db, writes };
}

describe("pinMentionOnRun", () => {
  const mention = { kind: "agent" as const, agent_slug: "cgo", intent: "what's holding growth back?" };

  it("merges the pin into the existing payload, scoped to run and tenant", async () => {
    const { db, writes } = fakeDb({ data: { payload: { thread_id: "t1", user_message_id: "m1" } }, error: null });
    expect(await pinMentionOnRun(db, TENANT, "run-1", mention)).toEqual({ ok: true });
    expect(writes[0]!.row).toEqual({
      payload: { thread_id: "t1", user_message_id: "m1", mention_target: "cgo", mention_intent: "what's holding growth back?" },
    });
    expect(writes[0]!.eqs).toEqual([["id", "run-1"], ["tenant_id", TENANT]]);
  });

  it("refuses (and writes nothing) when the payload could not be read", async () => {
    const { db, writes } = fakeDb({ data: null, error: { message: "boom" } });
    expect(await pinMentionOnRun(db, TENANT, "run-1", mention)).toEqual({ ok: false, error: "boom" });
    expect(writes).toHaveLength(0);
    const missing = fakeDb({ data: null, error: null });
    expect((await pinMentionOnRun(missing.db, TENANT, "run-1", mention)).ok).toBe(false);
    expect(missing.writes).toHaveLength(0);
  });

  it("reports a failed write", async () => {
    const { db } = fakeDb({ data: { payload: {} }, error: null }, { message: "denied" });
    expect(await pinMentionOnRun(db, TENANT, "run-1", mention)).toEqual({ ok: false, error: "denied" });
  });
});
