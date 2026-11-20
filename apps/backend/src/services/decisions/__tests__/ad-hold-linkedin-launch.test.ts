import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  holds: [] as Array<Record<string, unknown>>,
  ops: [] as Array<Record<string, unknown>>,
  lifecycle: [] as Array<Record<string, unknown>>,
  failOps: false,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/tenant-client", () => {
  const rows = (name: string) =>
    name === "ad_budget_reservations" ? db.holds : name === "ads_campaign_operations" ? db.ops : name === "ads_campaign_lifecycle" ? db.lifecycle : [];
  const table = (name: string) => {
    const eqs: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "not", "lt", "order", "or"]) q[m] = () => q;
    q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
    const match = () => rows(name).filter((r) => eqs.every(([c, v]) => c === "tenant_id" || r[c] === v));
    q.limit = async () => ({ data: name === "ad_budget_reservations" ? db.holds.filter((h) => h.status === "reserved") : match(), error: null });
    q.maybeSingle = async () =>
      name === "ads_campaign_operations" && db.failOps ? { data: null, error: { message: "connection reset" } } : { data: match()[0] ?? null, error: null };
    return q;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: table }),
    tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
      db.rpcs.push({ name, args });
      const h = db.holds.find((x) => x.id === args.p_hold_id);
      if (!h || h.status !== "reserved" || h.updated_at !== args.p_seen_updated_at) return { data: { status: h ? String(h.status) : "not_found" }, error: null };
      if (args.p_outcome === "landed") h.status = "committed";
      else Object.assign(h, { status: "released", reason: "not_landed" });
      return { data: { status: h.status }, error: null };
    },
  };
});

import { resolveInflightAdHolds } from "../ad-hold-resolve";

const NOW = new Date("2026-11-03T12:00:00Z");
const OLD = "2026-11-03T08:00:00.000Z";
const LAUNCH = "10000000-0000-4000-8000-0000000000a1";
const hold = (over: Record<string, unknown> = {}) => ({
  id: "h1",
  idem_key: `${LAUNCH}:resume`,
  op: "resume",
  platform: "linkedin",
  object_id: "bound",
  status: "reserved",
  reason: null,
  updated_at: OLD,
  decision_id: null,
  channel_action_id: null,
  provider_ref: null,
  ...over,
});
const op = (status: string) => ({ id: LAUNCH, status, campaign_binding_id: "bound", created_at: "2026-11-03T07:59:00.000Z" });
const run = () => resolveInflightAdHolds("t", NOW, { platforms: ["google"] });

beforeEach(() => {
  db.holds = [hold()];
  db.ops = [];
  db.lifecycle = [];
  db.failOps = false;
  db.rpcs = [];
});

describe("Review 34: the hourly check settles a LinkedIn launch's hold from Zavi's own launch records", () => {
  it("P1: a launch refused before LinkedIn whose claim was reopened leaves its hold 'Sending'; the hourly check gives it back so a new monthly budget is no longer blocked", async () => {
    expect(await run()).toEqual({ found: 0, released: 1, kept: 0, failed: 0 });
    expect(db.holds[0]).toMatchObject({ status: "released", reason: "not_landed" });
    expect(db.rpcs).toEqual([{ name: "resolve_inflight_ad_hold", args: { p_hold_id: "h1", p_outcome: "not_landed", p_seen_updated_at: OLD } }]);
  });
  it("P1: a refused launch that never tried to switch the campaign on is given back too", async () => {
    db.ops = [op("refused")];
    db.lifecycle = [{ campaign_binding_id: "bound", activation_attempted_at: null }];
    expect((await run()).released).toBe(1);
    expect(db.holds[0].status).toBe("released");
  });
  it("P5: a launch Zavi confirmed live whose hold was never counted is counted, so later relaunches and pauses work", async () => {
    db.ops = [op("succeeded")];
    expect(await run()).toEqual({ found: 1, released: 0, kept: 0, failed: 0 });
    expect(db.holds[0].status).toBe("committed");
  });
  it.each(["pending", "uncertain"])("a launch whose outcome is still %s keeps its hold", async (status) => {
    db.ops = [op(status)];
    expect((await run()).kept).toBe(1);
    expect(db.holds[0].status).toBe("reserved");
    expect(db.rpcs).toEqual([]);
  });
  it("a refused launch that tried to switch the campaign on after it was created keeps its hold: LinkedIn may have taken it", async () => {
    db.ops = [op("refused")];
    db.lifecycle = [{ campaign_binding_id: "bound", activation_attempted_at: "2026-11-03T08:00:00.000Z" }];
    expect((await run()).kept).toBe(1);
    expect(db.rpcs).toEqual([]);
  });
  it("a failed read of the launch keeps the hold, never releases it", async () => {
    db.failOps = true;
    expect((await run()).kept).toBe(1);
    expect(db.holds[0].status).toBe("reserved");
    expect(db.rpcs).toEqual([]);
  });
  it("a LinkedIn hold that belongs to a card is not judged from launch records", async () => {
    db.holds = [hold({ decision_id: "d1" })];
    const out = await run();
    expect(out.kept).toBe(1);
    expect(db.rpcs).toEqual([]);
    expect(db.holds[0].status).toBe("reserved");
  });
});
