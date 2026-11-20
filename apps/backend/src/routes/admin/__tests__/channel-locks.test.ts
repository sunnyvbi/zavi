
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown };

let calls: Call[] = [];
let tables: {
  blob: Record<string, unknown>;
  runs: Array<{ id: string; tenant_id: string }>;
  schedules: Array<{ tenant_id: string }>;
  bindings?: Array<{ id: string; tenant_id: string; provider_campaign_id: string; platform?: string }>;
  operations?: Array<{ campaign_binding_id: string; status: string; payload: { end_time?: unknown } | null; updated_at?: string }>;
  lifecycle?: Array<{ campaign_binding_id: string; stop_requested_at: string | null; stop_confirmed_at?: string | null }>;
  failLive?: boolean;
};

function setChannelLock(p: { p_slug: string; p_locked: boolean }) {
  const raw = tables.blob.locked_channel_slugs;
  const before = Array.isArray(raw) ? [...raw] : [];
  const after = [...before.filter((s) => s !== p.p_slug), ...(p.p_locked ? [p.p_slug] : [])];
  tables.blob = { ...tables.blob, locked_channel_slugs: after };
  return { before, after };
}

function fakeClient() {
  return {
    rpc(fn: string, params: { p_slug: string; p_locked: boolean; p_actor: string }) {
      calls.push({ table: "system_config", op: "rpc", filters: [], payload: { fn, ...params } });
      if (fn !== "system_config_set_channel_lock") return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
      return Promise.resolve({ data: setChannelLock(params), error: null });
    },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const result = () => {
        if (table === "system_config") {
          if (call.op === "upsert") {
            tables.blob = (call.payload as { blob: Record<string, unknown> }).blob;
            return { data: null, error: null };
          }
          return { data: { blob: structuredClone(tables.blob) }, error: null };
        }
        if (table === "agent_runs") return { data: tables.runs, error: null };
        if (table === "tenant_agent_schedules") return { data: tables.schedules, error: null };
        if (table === "ads_campaign_binding_details") {
          if (tables.failLive) return { data: null, error: { message: "binding read down" } };
          return { data: (tables.bindings ?? []).filter((b) => (b.platform ?? "linkedin") === "linkedin"), error: null };
        }
        if (table === "ads_campaign_operations")
          return { data: (tables.operations ?? []).filter((o) => ["succeeded", "uncertain", "pending"].includes(o.status)), error: null };
        if (table === "ads_campaign_lifecycle") return { data: (tables.lifecycle ?? []).filter((l) => l.stop_requested_at !== null), error: null };
        return { data: null, error: { message: `unexpected ${table}` } };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => (call.filters.push(["eq", c, v]), chain),
        in: (c: string, v: unknown) => (call.filters.push(["in", c, v]), chain),
        not: (c: string, o: string, v: unknown) => (call.filters.push(["not", c, [o, v]]), chain),
        order: () => chain,
        range: () => chain,
        delete: () => ((call.op = "delete"), chain),
        upsert: (payload: unknown) => {
          call.op = "upsert";
          call.payload = payload;
          return Promise.resolve(result());
        },
        maybeSingle: () => Promise.resolve(result()),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(res, rej),
      };
      return chain;
    },
  };
}

vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => fakeClient(),
  globalClient: () => fakeClient(),
}));

const stop = vi.fn();
vi.mock("@/services/agents/request-stop", () => ({
  requestStopForRun: (...a: unknown[]) => stop(...a),
}));

const audit = vi.fn();
vi.mock("@/services/staff/audit", () => ({
  writeStaffAudit: (...a: unknown[]) => audit(...a),
}));

import {
  executorIsShared,
  staffChannelLockImpact,
  staffChannelLockSet,
  staffChannelLocksGet,
} from "../channel-locks";
import { getChannel } from "@zavi/shared";

const STAFF = { user_id: "staff-1", email: "s@zavi.test" };

function req(params: Record<string, string> = {}, body: unknown = undefined): Request {
  return { params, body, staff: STAFF } as unknown as Request;
}

function res() {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const r = {
    status: (s: number) => ((out.status = s), r),
    json: (b: unknown) => ((out.body = b), r),
  };
  return { r: r as unknown as Response, out };
}

const writes = () => calls.filter((c) => c.op === "upsert" || c.op === "delete" || c.op === "rpc");

beforeEach(() => {
  calls = [];
  tables = {
    blob: { other_flag: true },
    runs: [
      { id: "run-a", tenant_id: "tenant-1" },
      { id: "run-b", tenant_id: "tenant-2" },
    ],
    schedules: [{ tenant_id: "tenant-2" }, { tenant_id: "tenant-3" }],
  };
  stop.mockReset();
  stop.mockResolvedValue({ ok: true, cancelling: true });
  audit.mockReset();
});

describe("POST /api/admin/channel-locks/:slug — lock", () => {
  it("stores the lock, stops each run with its own tenant, deletes the executor's schedules", async () => {
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "meta_ads" }, { locked: true }), r);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      locked: true,
      cancelled_runs: 2,
      deleted_schedules: 2,
      companies: 3,
      schedules_skipped_reason: null,
      errors: [],
    });

    const lockWrite = calls.find((c) => c.op === "rpc")!;
    expect(lockWrite.payload).toEqual({ fn: "system_config_set_channel_lock", p_slug: "meta_ads", p_locked: true, p_actor: "staff-1" });
    expect(tables.blob).toEqual({ other_flag: true, locked_channel_slugs: ["meta_ads"] });
    expect(calls.indexOf(lockWrite)).toBeLessThan(calls.findIndex((c) => c.table === "agent_runs"));

    const runRead = calls.find((c) => c.table === "agent_runs")!;
    expect(runRead.filters).toContainEqual(["eq", "channel_slug", "meta_ads"]);
    expect(runRead.filters).toContainEqual(["in", "status", ["queued", "running"]]);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls[0].slice(1)).toEqual(["tenant-1", "run-a"]);
    expect(stop.mock.calls[1].slice(1)).toEqual(["tenant-2", "run-b"]);

    const del = calls.find((c) => c.op === "delete")!;
    expect(del.table).toBe("tenant_agent_schedules");
    expect(del.filters).toEqual([["eq", "agent_slug", "meta_ads"]]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel_lock.engage", actor_user_id: "staff-1" }),
    );
  });

  it("locking seo deletes only seo's schedules now that geo has its own agent", async () => {
    expect(getChannel("geo")!.executor).toBe("geo");
    const { r } = res();
    await staffChannelLockSet(req({ slug: "seo" }, { locked: true }), r);
    const del = calls.find((c) => c.op === "delete")!;
    expect(del.filters).toEqual([["eq", "agent_slug", "seo"]]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("executorIsShared refuses schedule deletes when two channels share an executor", () => {
    expect(executorIsShared({ executor: "meta_ads" })).toBe(false);
    expect(executorIsShared({ executor: "x" }, [{ executor: "x" }, { executor: "x" }])).toBe(true);
    expect(executorIsShared({ executor: "x" }, [{ executor: "x" }, { executor: "y" }])).toBe(false);
  });

  it("a run that is already terminal is not counted as cancelled", async () => {
    stop.mockResolvedValueOnce({ ok: true, already_terminal: true });
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "meta_ads" }, { locked: true }), r);
    expect(out.body).toMatchObject({ cancelled_runs: 1 });
  });

  it("unlock clears the flag only — no run stop, no schedule delete", async () => {
    tables.blob = { locked_channel_slugs: ["meta_ads", "sms"] };
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "meta_ads" }, { locked: false }), r);
    expect(out.body).toEqual({ ok: true, locked: false });
    expect(stop).not.toHaveBeenCalled();
    expect(calls.some((c) => c.op === "delete" || c.table === "agent_runs")).toBe(false);
    expect(tables.blob).toEqual({ locked_channel_slugs: ["sms"] });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel_lock.clear", meta: { channel_slug: "meta_ads", before: ["meta_ads", "sms"], after: ["sms"] } }),
    );
  });

  it("two staff locking different channels at the same moment keep both locks and every other setting", async () => {
    tables.blob = { other_flag: true, fleet_halt: true };
    tables.runs = [];
    tables.schedules = [];
    const a = res();
    const b = res();
    await Promise.all([
      staffChannelLockSet(req({ slug: "meta_ads" }, { locked: true }), a.r),
      staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), b.r),
    ]);
    expect(a.out.status).toBe(200);
    expect(b.out.status).toBe(200);
    expect(tables.blob.other_flag).toBe(true);
    expect(tables.blob.fleet_halt).toBe(true);
    expect([...(tables.blob.locked_channel_slugs as string[])].sort()).toEqual(["linkedin_ads", "meta_ads"]);
  });

  it("an unlock racing a lock of another channel does not bring the unlocked channel back or drop the new lock", async () => {
    tables.blob = { locked_channel_slugs: ["sms"] };
    tables.runs = [];
    tables.schedules = [];
    await Promise.all([
      staffChannelLockSet(req({ slug: "sms" }, { locked: false }), res().r),
      staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), res().r),
    ]);
    expect(tables.blob.locked_channel_slugs).toEqual(["linkedin_ads"]);
  });

  it("rejects an unknown slug with 400 and writes nothing", async () => {
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "myspace" }, { locked: true }), r);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: { code: "unknown_channel" } });
    expect(calls).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a bad body with 400", async () => {
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "meta_ads" }, { locked: "yes" }), r);
    expect(out.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });
});

describe("locking LinkedIn with live campaigns", () => {
  const FUTURE = Date.now() + 86_400_000;
  const live = (id: string, tenant: string, provider: string) => ({ id, tenant_id: tenant, provider_campaign_id: provider });

  beforeEach(() => {
    tables.bindings = [
      live("live-1", "tenant-1", "9001"),
      live("live-2", "tenant-4", "9002"),
      live("never-launched", "tenant-1", "9003"),
      live("refused", "tenant-1", "9004"),
      live("stopped", "tenant-1", "9005"),
      live("ended", "tenant-1", "9006"),
      { ...live("meta-one", "tenant-1", "9007"), platform: "meta" },
    ];
    tables.operations = [
      { campaign_binding_id: "live-1", status: "succeeded", payload: { end_time: FUTURE } },
      { campaign_binding_id: "live-2", status: "uncertain", payload: { end_time: FUTURE } },
      { campaign_binding_id: "refused", status: "refused", payload: { end_time: FUTURE } },
      { campaign_binding_id: "stopped", status: "succeeded", payload: { end_time: FUTURE } },
      { campaign_binding_id: "ended", status: "succeeded", payload: { end_time: Date.now() - 1000 } },
      { campaign_binding_id: "meta-one", status: "succeeded", payload: { end_time: FUTURE } },
    ];
    tables.lifecycle = [
      { campaign_binding_id: "live-1", stop_requested_at: null },
      { campaign_binding_id: "stopped", stop_requested_at: "2026-10-29T00:00:00Z", stop_confirmed_at: "2026-10-29T00:01:00Z" },
    ];
  });

  it("must-catch: a campaign whose pause is saved but not confirmed, or that was relaunched after its pause, is counted as still spending in the preview and the lock", async () => {
    tables.bindings = [...(tables.bindings ?? []), live("pausing", "tenant-5", "9010"), live("old-confirm", "tenant-5", "9011"), live("relaunched", "tenant-6", "9012")];
    tables.operations = [
      ...(tables.operations ?? []),
      { campaign_binding_id: "pausing", status: "succeeded", payload: { end_time: FUTURE }, updated_at: "2026-10-28T00:00:00Z" },
      { campaign_binding_id: "old-confirm", status: "succeeded", payload: { end_time: FUTURE }, updated_at: "2026-10-28T00:00:00Z" },
      { campaign_binding_id: "relaunched", status: "succeeded", payload: { end_time: FUTURE }, updated_at: "2026-10-30T00:00:00Z" },
    ];
    tables.lifecycle = [
      ...(tables.lifecycle ?? []),
      { campaign_binding_id: "pausing", stop_requested_at: "2026-10-29T00:00:00Z", stop_confirmed_at: null },
      { campaign_binding_id: "old-confirm", stop_requested_at: "2026-10-29T00:00:00Z", stop_confirmed_at: "2026-10-27T00:00:00Z" },
      { campaign_binding_id: "relaunched", stop_requested_at: "2026-10-29T00:00:00Z", stop_confirmed_at: "2026-10-29T00:01:00Z" },
    ];
    const preview = res();
    await staffChannelLockImpact(req({ slug: "linkedin_ads" }), preview.r);
    const body = preview.out.body as { live_campaigns: Array<{ provider_campaign_id: string }>; live_campaigns_note: string };
    expect(body.live_campaigns.map((c) => c.provider_campaign_id).sort()).toEqual(["9001", "9002", "9010", "9011", "9012"]);
    expect(body.live_campaigns_note).toMatch(/5 LinkedIn campaigns launched through Zavi across 4 companies keep spending/);
    const locked = res();
    await staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), locked.r);
    const lockBody = locked.out.body as { live_campaigns: Array<{ provider_campaign_id: string }> };
    expect(lockBody.live_campaigns.map((c) => c.provider_campaign_id).sort()).toEqual(["9001", "9002", "9010", "9011", "9012"]);
    expect(JSON.stringify(audit.mock.calls)).toContain("9010");
    expect(lockBody.live_campaigns.map((c) => c.provider_campaign_id)).not.toContain("9005");
  });

  it("the preview names exactly the live campaigns and says they keep spending", async () => {
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "linkedin_ads" }), r);
    const body = out.body as { live_campaigns: Array<{ provider_campaign_id: string }>; live_campaigns_note: string };
    expect(body.live_campaigns.map((c) => c.provider_campaign_id)).toEqual(["9001", "9002"]);
    expect(body.live_campaigns_note).toMatch(/does not pause live ads/);
    expect(body.live_campaigns_note).toMatch(/2 LinkedIn campaigns launched through Zavi across 2 companies keep spending/);
    expect(writes()).toHaveLength(0);
  });

  it("the lock response and the audit both record what keeps spending", async () => {
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), r);
    expect(out.body).toMatchObject({ ok: true, live_campaigns: [{ provider_campaign_id: "9001" }, { provider_campaign_id: "9002" }] });
    expect((out.body as { live_campaigns_note: string }).live_campaigns_note).toMatch(/keep spending/);
    expect(JSON.stringify(audit.mock.calls)).toContain("9001");
  });

  it("a preview that cannot read the campaigns still answers with the runs and schedules, and says the list is unread instead of showing none", async () => {
    tables.failLive = true;
    tables.runs = [{ id: "run-1", tenant_id: "tenant-1" }];
    tables.schedules = [{ tenant_id: "tenant-2" }];
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "linkedin_ads" }), r);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ running_runs: 1, schedules: 1, companies: 2, live_campaigns: [], live_campaigns_unread: true });
    const note = (out.body as { live_campaigns_note: string }).live_campaigns_note;
    expect(note).toMatch(/could not be read/);
    expect(note).toMatch(/You can still lock/);
    expect(note).not.toMatch(/binding read down/);
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("the preview failing to read the campaigns does not stop the lock that follows it: the flag is stored, runs stop, schedules go", async () => {
    tables.failLive = true;
    tables.runs = [{ id: "run-1", tenant_id: "tenant-1" }];
    tables.schedules = [{ tenant_id: "tenant-2" }];
    stop.mockResolvedValue({ ok: true, cancelling: true });
    const preview = res();
    await staffChannelLockImpact(req({ slug: "linkedin_ads" }), preview.r);
    expect(preview.out.status).toBe(200);
    const locked = res();
    await staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), locked.r);
    expect(locked.out.body).toMatchObject({ ok: true, locked: true, cancelled_runs: 1, deleted_schedules: 1 });
    expect(tables.blob.locked_channel_slugs).toContain("linkedin_ads");
    expect(stop).toHaveBeenCalledWith(expect.anything(), "tenant-1", "run-1");
  });

  it("must not catch: a preview whose list reads fine is not marked unread", async () => {
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "linkedin_ads" }), r);
    expect(out.body).toMatchObject({ live_campaigns_unread: false });
  });

  it("a lock that cannot read the campaigns still locks and reports the gap", async () => {
    tables.failLive = true;
    const { r, out } = res();
    await staffChannelLockSet(req({ slug: "linkedin_ads" }, { locked: true }), r);
    expect(out.body).toMatchObject({ ok: true, locked: true });
    expect((out.body as { errors: string[] }).errors.join()).toMatch(/live campaigns unreadable, so some may keep spending/);
  });

  it("another channel's lock does not read or report LinkedIn campaigns", async () => {
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "meta_ads" }), r);
    expect(out.body).toMatchObject({ live_campaigns: [], live_campaigns_note: null });
    expect(calls.some((c) => c.table === "ads_campaign_operations")).toBe(false);
  });
});

describe("GET /api/admin/channel-locks/:slug/impact", () => {
  it("returns N/M/K with no side effects", async () => {
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "meta_ads" }), r);
    expect(out.body).toEqual({
      running_runs: 2,
      schedules: 2,
      companies: 3,
      schedules_skipped_reason: null,
      live_campaigns: [],
      live_campaigns_note: null,
      live_campaigns_unread: false,
    });
    expect(writes()).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects an unknown slug with 400", async () => {
    const { r, out } = res();
    await staffChannelLockImpact(req({ slug: "../config" }), r);
    expect(out.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/admin/channel-locks", () => {
  it("lists every registry channel with its lock state", async () => {
    tables.blob = { locked_channel_slugs: ["sms"] };
    const { r, out } = res();
    await staffChannelLocksGet(req(), r);
    const body = out.body as { channels: Array<{ slug: string; locked: boolean }> };
    expect(body.channels.length).toBeGreaterThan(0);
    expect(body.channels.filter((c) => c.locked).map((c) => c.slug)).toEqual(["sms"]);
  });
});
