import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => {
    throw new Error("real tenantClient must not be used in this test");
  },
  asTenantId: (t: string) => t,
}));

import {
  stampThreadChannelOrigin,
  type OriginDb,
  type OriginFilter,
} from "@/services/agents/thread-channel-origin";

const T1 = "00000000-0000-0000-0000-000000000001";
const U1 = "10000000-0000-0000-0000-000000000001";
const THREAD = "11111111-1111-4111-8111-111111111111";
const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Call = { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

function fakeDb(opts: {
  card?: { id: string; channel_slug: string } | null;
  cardError?: string | null;
  updateErrors?: Array<string | null>;
} = {}) {
  const calls: Call[] = [];
  const tenantsAsked: string[] = [];
  let updateN = 0;
  const db: OriginDb = {
    from(table) {
      const make = (call: Call, settle: () => { data?: unknown; error: { message: string } | null }): OriginFilter => {
        const f: OriginFilter = {
          eq(col, val) {
            call.filters.push(["eq", col, val]);
            return f;
          },
          is(col, val) {
            call.filters.push(["is", col, val]);
            return f;
          },
          maybeSingle() {
            return Promise.resolve(settle());
          },
          then(onF, onR) {
            return Promise.resolve(settle()).then(onF, onR);
          },
        };
        return f;
      };
      return {
        select() {
          const call: Call = { table, op: "select", filters: [] };
          calls.push(call);
          return make(call, () =>
            opts.cardError
              ? { data: null, error: { message: opts.cardError } }
              : { data: opts.card ?? null, error: null },
          );
        },
        update(values) {
          const call: Call = { table, op: "update", values, filters: [] };
          calls.push(call);
          return make(call, () => {
            const err = opts.updateErrors?.[updateN++] ?? null;
            return { error: err ? { message: err } : null };
          });
        },
      };
    },
  };
  const warn = vi.fn();
  return {
    calls,
    tenantsAsked,
    warn,
    deps: {
      db: (t: string) => {
        tenantsAsked.push(t);
        return db;
      },
      warn,
    },
  };
}

const base = { tenantId: T1, userId: U1, threadId: THREAD };

describe("stampThreadChannelOrigin", () => {
  it("stamps channel_slug on a thread sent from the channel page", async () => {
    const f = fakeDb();
    await stampThreadChannelOrigin({ ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads" }, f.deps);
    const upd = f.calls.filter((c) => c.op === "update");
    expect(upd).toHaveLength(1);
    expect(upd[0].table).toBe("agent_threads");
    expect(upd[0].values).toEqual({ channel_slug: "chatgpt_ads", channel_action_id: null });
  });

  it("scopes the write to the caller's tenant, id, user, channel agent, and unstamped rows only", async () => {
    const f = fakeDb();
    await stampThreadChannelOrigin({ ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads" }, f.deps);
    expect(f.tenantsAsked).toEqual([T1]);
    const upd = f.calls.find((c) => c.op === "update")!;
    expect(upd.filters).toEqual([
      ["eq", "id", THREAD],
      ["eq", "user_id", U1],
      ["eq", "agent_slug", "chatgpt_ads"],
      ["is", "channel_slug", null],
    ]);
  });

  it("stamps the card when it is this tenant's card on the same channel", async () => {
    const f = fakeDb({ card: { id: CARD, channel_slug: "chatgpt_ads" } });
    await stampThreadChannelOrigin(
      { ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: CARD.toUpperCase() },
      f.deps,
    );
    const sel = f.calls.find((c) => c.op === "select")!;
    expect(sel.table).toBe("channel_actions");
    expect(sel.filters).toEqual([["eq", "id", CARD]]);
    expect(f.calls.find((c) => c.op === "update")!.values).toEqual({
      channel_slug: "chatgpt_ads",
      channel_action_id: CARD,
    });
  });

  it("drops a card the tenant-scoped read cannot see (another tenant's) and still stamps the channel", async () => {
    const f = fakeDb({ card: null });
    await stampThreadChannelOrigin(
      { ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: CARD },
      f.deps,
    );
    expect(f.calls.find((c) => c.op === "update")!.values).toEqual({
      channel_slug: "chatgpt_ads",
      channel_action_id: null,
    });
  });

  it("drops a card whose channel differs from page_channel", async () => {
    const f = fakeDb({ card: { id: CARD, channel_slug: "meta_ads" } });
    await stampThreadChannelOrigin(
      { ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: CARD },
      f.deps,
    );
    expect(f.calls.find((c) => c.op === "update")!.values).toMatchObject({ channel_action_id: null });
  });

  it("drops a non-uuid card id without reading", async () => {
    const f = fakeDb();
    await stampThreadChannelOrigin(
      { ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: "staged-post-1" },
      f.deps,
    );
    expect(f.calls.filter((c) => c.op === "select")).toHaveLength(0);
    expect(f.calls.find((c) => c.op === "update")!.values).toMatchObject({ channel_action_id: null });
  });

  it("ignores an unknown channel slug (no read, no write)", async () => {
    const f = fakeDb();
    await stampThreadChannelOrigin({ ...base, pageChannel: "myspace_ads", agentSlug: "myspace_ads" }, f.deps);
    expect(f.calls).toHaveLength(0);
    expect(f.tenantsAsked).toHaveLength(0);
  });

  it("retries once in the request when the first write fails", async () => {
    const f = fakeDb({ updateErrors: ["timeout", null] });
    await stampThreadChannelOrigin({ ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads" }, f.deps);
    expect(f.calls.filter((c) => c.op === "update")).toHaveLength(2);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("a card read error is retried, not silently stamped without the card", async () => {
    const f = fakeDb({ cardError: "read failed" });
    await stampThreadChannelOrigin(
      { ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: CARD },
      f.deps,
    );
    expect(f.calls.filter((c) => c.op === "select")).toHaveLength(2);
    expect(f.calls.filter((c) => c.op === "update")).toHaveLength(0);
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it("two failed writes warn and do not throw", async () => {
    const f = fakeDb({ updateErrors: ["boom", "boom"] });
    await expect(
      stampThreadChannelOrigin({ ...base, pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads" }, f.deps),
    ).resolves.toBeUndefined();
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(String(f.warn.mock.calls[0][0])).toContain(THREAD);
  });
});
