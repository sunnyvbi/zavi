import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ found: [] as unknown[], selectErr: null as unknown, updates: [] as unknown[], inserts: [] as unknown[], filters: [] as unknown[][], insertErr: null as unknown }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => {
      expect(t).toBe("connector_events");
      const q: any = {
        select: () => q,
        eq: (...a: unknown[]) => { m.filters.push(["eq", ...a]); return q; },
        is: (...a: unknown[]) => { m.filters.push(["is", ...a]); return q; },
        gte: (...a: unknown[]) => { m.filters.push(["gte", ...a]); return q; },
        order: () => q,
        limit: async () => ({ data: m.found, error: m.selectErr }),
        update: (v: unknown) => { m.updates.push(v); return { eq: () => ({ is: async () => ({ error: null }) }) }; },
        insert: async (v: unknown) => { m.inserts.push(v); return { error: m.insertErr }; },
      };
      return q;
    },
  }),
}));
import { recordConnectorEvent } from "../connector-events";

const ev = { tenant_id: "T1", slug: "composio.reddit_ads", action: "disconnect" as const, actor_user_id: "U1", via: "composio_disconnect" };
const NOW = new Date("2026-10-15T16:00:00Z");
beforeEach(() => { m.found = []; m.selectErr = null; m.updates = []; m.inserts = []; m.filters = []; m.insertErr = null; });

describe("recordConnectorEvent (fills in the trigger's row: one row per event)", () => {
  it("claims the trigger's actor-less row for the same tenant, slug and action from the last 2 minutes", async () => {
    m.found = [{ id: 7, meta: { via: "db", account_label: "Acme" } }];
    await recordConnectorEvent(ev, NOW);
    expect(m.filters).toEqual(expect.arrayContaining([["eq", "tenant_id", "T1"], ["eq", "slug", "composio.reddit_ads"], ["eq", "action", "disconnect"], ["is", "actor_user_id", null], ["gte", "created_at", "2026-10-15T15:58:00.000Z"]]));
    expect(m.updates).toEqual([{ actor_user_id: "U1", meta: { via: "composio_disconnect", account_label: "Acme" } }]);
    expect(m.inserts).toEqual([]);
  });

  it("no trigger row: inserts one", async () => {
    await recordConnectorEvent(ev, NOW);
    expect(m.updates).toEqual([]);
    expect(m.inserts.flat()).toEqual([{ tenant_id: "T1", slug: "composio.reddit_ads", action: "disconnect", actor_user_id: "U1", meta: { via: "composio_disconnect" } }]);
  });

  it("a failed read or write never throws: the connect or disconnect carries on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.selectErr = { message: "relation does not exist" };
    await expect(recordConnectorEvent(ev, NOW)).resolves.toBeUndefined();
    m.selectErr = null; m.insertErr = { message: "boom" };
    await expect(recordConnectorEvent(ev, NOW)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
