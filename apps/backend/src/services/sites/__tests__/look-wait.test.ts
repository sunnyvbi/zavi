import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({
  rpcResults: [] as Array<{ data: unknown; error: { message: string } | null }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: unknown; eq: Array<[string, unknown]> }>,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return db.rpcResults.shift() ?? { data: { ok: true, cancelled: false }, error: null };
    },
    from: (table: string) => {
      const u = { table, patch: null as unknown, eq: [] as Array<[string, unknown]> };
      const b = {
        update: (patch: unknown) => ((u.patch = patch), db.updates.push(u), b),
        eq: (c: string, v: unknown) => (u.eq.push([c, v]), b),
        then: (resolve: (r: { error: null }) => void) => resolve({ error: null }),
      };
      return b;
    },
  }),
}));

import {
  AWAITING_LOOK_GRAPH_MARKER,
  buildAwaitsLook,
  checkParkedLookRun,
  LOOK_PARK_EXPIRY_MS,
  lookAwaitingSiteId,
  rowAwaitsPick,
  SITE_BUILD_WAITS_FOR_LOOK_SETTING,
  siteAwaitsLook,
} from "../look-wait";
import { APP_SETTINGS } from "@/services/settings/registry";

const pending = (payload: Record<string, unknown>) => ({ status: "pending", payload });
const done = (payload: Record<string, unknown>) => ({ status: "done", payload });

describe("lookAwaitingSiteId", () => {
  it("names the site only when the FIRST pending node waits on the look", () => {
    expect(lookAwaitingSiteId([done({ stage: "provision" }), pending({ stage: "build", await_look: true, site_id: " s1 " })])).toBe("s1");
    expect(lookAwaitingSiteId([pending({ stage: "build" }), pending({ stage: "deploy", await_look: true, site_id: "s1" })])).toBeNull();
    expect(lookAwaitingSiteId([{ status: "dispatched", payload: { await_look: true, site_id: "s1" } }])).toBeNull();
    expect(lookAwaitingSiteId([pending({ await_look: "true", site_id: "s1" })])).toBeNull();
    expect(lookAwaitingSiteId([pending({ await_look: true })])).toBeNull();
    expect(lookAwaitingSiteId([pending({ await_look: true, site_id: "  " })])).toBeNull();
    expect(lookAwaitingSiteId(null)).toBeNull();
    expect(lookAwaitingSiteId({ status: "pending" })).toBeNull();
    expect(lookAwaitingSiteId([null, { status: "pending", payload: null }])).toBeNull();
  });

  it("the cron marker is exactly a pending node with await_look true", () => {
    expect(JSON.parse(JSON.stringify(AWAITING_LOOK_GRAPH_MARKER))).toEqual([{ status: "pending", payload: { await_look: true } }]);
  });
});

describe("rowAwaitsPick", () => {
  const three = [{ id: "a" }, { id: "b" }, { id: "c" }] as never[];
  const row = { theme_mode: "theme_css" as const, chosen_at: null, sealed_at: null, directions: three };
  it("waits only for a live-switchable, unpicked, unsealed look", () => {
    expect(rowAwaitsPick(row)).toBe(true);
    expect(rowAwaitsPick(null)).toBe(false);
    expect(rowAwaitsPick({ ...row, chosen_at: "2026-10-07T00:00:00Z" })).toBe(false);
    expect(rowAwaitsPick({ ...row, sealed_at: "2026-10-07T00:00:00Z" })).toBe(false);
    expect(rowAwaitsPick({ ...row, theme_mode: "index_css" })).toBe(false);
    expect(rowAwaitsPick({ ...row, theme_mode: "none" })).toBe(false);
  });

  it("never waits when there are fewer than two websites to pick from", () => {
    expect(rowAwaitsPick({ ...row, directions: [] })).toBe(false);
    expect(rowAwaitsPick({ ...row, directions: [three[0]!] })).toBe(false);
    expect(rowAwaitsPick({ ...row, directions: null as never })).toBe(false);
    expect(rowAwaitsPick({ ...row, directions: three.slice(0, 2) })).toBe(true);
  });
});

describe("buildAwaitsLook", () => {
  const unpicked = { theme_mode: "theme_css", chosen_at: null, sealed_at: null, directions: [{ id: "a" }, { id: "b" }] } as never;
  it("flag off releases the build without reading the store", async () => {
    const get = vi.fn(async () => unpicked);
    expect(await buildAwaitsLook({ waitsForLook: async () => false, store: { get } }, { tenant_id: "t", site_id: "s" })).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("flag on defers to the stored pick, scoped by tenant and site", async () => {
    const get = vi.fn(async () => unpicked);
    expect(await buildAwaitsLook({ waitsForLook: async () => true, store: { get } }, { tenant_id: "t", site_id: "s" })).toBe(true);
    expect(get).toHaveBeenCalledWith("t", "s");
  });

  it("a settings or store error propagates, so the conductor holds", async () => {
    await expect(buildAwaitsLook({ waitsForLook: async () => Promise.reject(new Error("x")), store: { get: async () => null } }, { tenant_id: "t", site_id: "s" })).rejects.toThrow("x");
    await expect(siteAwaitsLook({ get: async () => Promise.reject(new Error("y")) }, { tenant_id: "t", site_id: "s" })).rejects.toThrow("y");
  });
});

describe("site_build_waits_for_look setting", () => {
  it("is a per-tenant boolean, on by default", () => {
    const def = APP_SETTINGS[SITE_BUILD_WAITS_FOR_LOOK_SETTING];
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(true);
  });
});

describe("parked build expiry", () => {
  it("asks the database (expire_parked_look_run) with the tenant injected and the 30 minute wait", async () => {
    expect(LOOK_PARK_EXPIRY_MS).toBe(30 * 60_000);
    db.rpcCalls.length = 0;
    db.rpcResults.push({ data: { state: "expired", parked_at: "2026-10-12T10:00:00+00:00" }, error: null });
    db.rpcResults.push({ data: { state: "ended" }, error: null });
    const input = { tenant_id: "11111111-1111-4111-8111-111111111111", conductor_run_id: "r1" };
    expect(await checkParkedLookRun(input)).toEqual({ state: "expired", parked_at: "2026-10-12T10:00:00+00:00" });
    expect(await checkParkedLookRun(input)).toEqual({ state: "ended", parked_at: null });
    expect(db.rpcCalls).toEqual([
      { fn: "expire_parked_look_run", args: { p_conductor_run_id: "r1", p_expiry_seconds: 1800, p_tenant_id: "11111111-1111-4111-8111-111111111111" } },
      { fn: "expire_parked_look_run", args: { p_conductor_run_id: "r1", p_expiry_seconds: 1800, p_tenant_id: "11111111-1111-4111-8111-111111111111" } },
    ]);
  });

  it("a database error or a reply without a known state throws", async () => {
    db.rpcResults.push({ data: null, error: { message: "db down" } });
    await expect(checkParkedLookRun({ tenant_id: "t1", conductor_run_id: "r1" })).rejects.toThrow(/db down/);
    db.rpcResults.push({ data: { state: "maybe" }, error: null });
    await expect(checkParkedLookRun({ tenant_id: "t1", conductor_run_id: "r1" })).rejects.toThrow(/no state/);
  });
});
