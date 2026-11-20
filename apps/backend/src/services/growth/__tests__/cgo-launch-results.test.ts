
import { describe, it, expect, vi, beforeEach } from "vitest";

const tables: Record<string, Array<Record<string, unknown>>> = {};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let aliases: Array<[string, string]> = [];
      let sort: [string, boolean] | null = null;
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: (cols: string) => {
          aliases = cols.split(",").map((c) => c.trim()).filter((c) => c.includes(":")).map((c) => c.split(":") as [string, string]);
          return q;
        },
        order: (k: string, o?: { ascending?: boolean }) => ((sort = [k, o?.ascending !== false]), q),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
        gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
        lte: (k: string, v: string) => (filters.push((r) => String(r[k]) <= v), q),
        limit: async (n: number) => ({
          data: (tables[table] ?? [])
            .filter((r) => filters.every((f) => f(r)))
            .sort((x, y) => (sort ? (sort[1] ? 1 : -1) * String(x[sort[0]]).localeCompare(String(y[sort[0]])) : 0))
            .slice(0, n)
            .map((r) => ({ ...r, ...Object.fromEntries(aliases.map(([a, path]) => [a, r[path] ?? null])) })),
          error: null,
        }),
      });
      return q;
    },
  }),
}));

const fbGet = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/meta-ads/_client", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/meta-ads/_client")>()),
  fbGet,
  metaAdsCreds: async () => ({ ad_account_id: "act_1" }),
}));

import { launchResultLine, launchWindow, readOwnLaunchResults, type LaunchNumbers } from "../cgo-evidence";

const NOW = new Date("2026-10-20T12:00:00Z");
const ZONE = "America/Los_Angeles";
const order = (id: string, exec_class: string, executed_at: string, over: Record<string, unknown> = {}) => ({
  id,
  exec_class,
  title: `Copy of ${id}`,
  executed_at,
  exec_status: "executed",
  approved_by_source: "cgo",
  "body->>cgo_order_origin": "ad_spend_controller",
  ...over,
});
const deps = (read: (id: string, since: string, until: string) => Promise<LaunchNumbers>) => {
  const spy = vi.fn(read);
  return { zone: async () => ZONE, read: (_p: string, _c: string, id: string, since: string, until: string) => spy(id, since, until), spy };
};
const nums = (spend: number, conversions: number, leads: number | null = 0, clicks: number | null = 0) => ({ spend, conversions, leads, clicks });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("launch windows: whole days on the account's clock, after the day it went live", () => {
  it("a launch at 23:50 local counts from the next day; 3 whole days must be over", () => {
    expect(launchWindow("2026-10-16T06:50:00Z", "2026-10-18", ZONE)).toBeNull();
    expect(launchWindow("2026-10-16T06:50:00Z", "2026-10-19", ZONE)).toEqual({ days: 3, since: "2026-10-16", until: "2026-10-18" });
    expect(launchWindow("2026-10-10T18:00:00Z", "2026-10-20", ZONE)).toEqual({ days: 7, since: "2026-10-11", until: "2026-10-17" });
  });

  it("a first-3-days line is provisional and never the only reason to cut, and names every kind of result", () => {
    const line = launchResultLine({ id: "a", exec_class: "meta_ads.duplicate_ad_set", title: "Bouquets (copy, Riverside)", by_controller: true, object_id: "77", live_at: "2026-10-16T09:00:00Z" }, { days: 3 }, nums(90, 3, 2, 40));
    expect(line).toContain("first 3 days (provisional: never the only reason to cut)");
    expect(line).toContain("$90.00 spent; 3 conversions ($30.00 each)");
    expect(line).toContain("2 leads ($45.00 each); 40 clicks");
  });
});

describe("readOwnLaunchResults", () => {
  it("must catch (florist): a copy is measured on the copy's own id from the change record, live when made", async () => {
    tables.channel_actions = [order("ca1", "meta_ads.duplicate_ad_set", "2026-10-10T18:00:00Z")];
    tables.ad_object_changes = [{ action_table: "channel_actions", action_id: "ca1", object_id: "copy-77", before_status: null, change_kind: "status", platform: "meta" }];
    const d = deps(async () => nums(210, 6));
    const lines = await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("copy-77", "2026-10-11", "2026-10-17");
    expect(lines).toEqual([expect.stringContaining("first 7 days: $210.00 spent; 6 conversions ($35.00 each)")]);
  });

  it("must catch (SaaS): a new ad set made off is measured from when it was switched on, not from when it was made", async () => {
    tables.channel_actions = [order("ca2", "meta_ads.create_ad_set", "2026-10-08T18:00:00Z", { "exec_result->created->>id": "rt-9", "exec_result->created->>status": "PAUSED" })];
    tables.ad_object_changes = [{ object_id: "rt-9", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-15T18:00:00Z" }];
    const d = deps(async () => nums(40, 0, 4, 120));
    const lines = await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("rt-9", "2026-10-16", "2026-10-18");
    expect(lines[0]).toContain("first 3 days (provisional");
    expect(lines[0]).toContain("4 leads ($10.00 each)");
  });

  it("must not catch: a create never switched on, a raise, a founder's own copy, a failed one, or one live under 3 whole days", async () => {
    tables.channel_actions = [
      order("p1", "meta_ads.create_ad_set", "2026-10-10T18:00:00Z", { "exec_result->created->>id": "never-on", "exec_result->created->>status": "PAUSED" }),
      order("r1", "meta_ads.update_ad_set_budget", "2026-10-10T18:00:00Z"),
      order("f1", "meta_ads.duplicate_ad_set", "2026-10-10T18:00:00Z", { approved_by_source: "founder", "body->>cgo_order_origin": null }),
      order("x1", "meta_ads.duplicate_ad_set", "2026-10-10T18:00:00Z", { exec_status: "failed" }),
      order("y1", "meta_ads.create_ad", "2026-10-18T18:00:00Z", { "exec_result->created->>id": "ad-1", "exec_result->created->>status": "ACTIVE" }),
    ];
    const d = deps(async () => nums(1, 1));
    expect(await readOwnLaunchResults("t1", NOW, d)).toEqual([]);
    expect(d.spy).not.toHaveBeenCalled();
  });

  it("must catch (SaaS): a new ad made in a paused ad set with a long on/off history is measured from the switch-on after it", async () => {
    tables.channel_actions = [
      order("ca4", "meta_ads.create_ad", "2026-10-08T18:00:00Z", { "exec_result->created->>id": "ad-5", "exec_result->created->>status": "PAUSED", "exec_payload->>ad_set_id": "set-old" }),
    ];
    const old = [1, 2, 3, 4, 5, 6].map((k) => ({ object_id: "set-old", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: `2026-09-0${k}T10:00:00Z` }));
    tables.ad_object_changes = [...old, { object_id: "set-old", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-15T18:00:00Z" }];
    const d = deps(async () => nums(30, 0, 0, 0));
    await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("ad-5", "2026-10-16", "2026-10-18");
  });

  it("an ad switched on whose read-back was unconfirmed (UNVERIFIED) is live when made", async () => {
    tables.channel_actions = [order("ca5", "meta_ads.create_ad", "2026-10-10T18:00:00Z", { "exec_result->created->>id": "ad-6", "exec_result->created->>status": "UNVERIFIED" })];
    const d = deps(async () => nums(70, 0, 7, 0));
    const lines = await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("ad-6", "2026-10-11", "2026-10-17");
    expect(lines[0]).toContain("7 leads ($10.00 each)");
  });

  it("a retried create (UNVERIFIED) in a paused ad set is measured from that ad set's later switch-on", async () => {
    tables.channel_actions = [
      order("ca7", "meta_ads.create_ad", "2026-10-08T18:00:00Z", { "exec_result->created->>id": "ad-7", "exec_result->created->>status": "UNVERIFIED", "exec_payload->>ad_set_id": "set-7" }),
    ];
    tables.ad_object_changes = [{ object_id: "set-7", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-15T18:00:00Z" }];
    const d = deps(async () => nums(10, 0));
    await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("ad-7", "2026-10-16", "2026-10-18");
  });

  it("must not catch: a retried create (UNVERIFIED) in an ad set already on counts from when it was made, whatever toggles later", async () => {
    tables.channel_actions = [
      order("ca8", "meta_ads.create_ad", "2026-10-10T18:00:00Z", { "exec_result->created->>id": "ad-8", "exec_result->created->>status": "UNVERIFIED", "exec_payload->>ad_set_id": "set-8" }),
    ];
    tables.ad_object_changes = [
      { object_id: "set-8", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-01T18:00:00Z" },
      { object_id: "set-8", platform: "meta", change_kind: "status", after_status: "PAUSED", occurred_at: "2026-10-12T18:00:00Z" },
      { object_id: "set-8", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-13T18:00:00Z" },
    ];
    const d = deps(async () => nums(10, 0));
    await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("ad-8", "2026-10-11", "2026-10-17");
  });

  it("one ad set's long history does not hide another create's switch-on", async () => {
    tables.channel_actions = [
      order("old", "meta_ads.create_ad_set", "2026-09-25T18:00:00Z", { "exec_result->created->>id": "set-busy", "exec_result->created->>status": "PAUSED" }),
      order("new", "meta_ads.create_ad_set", "2026-10-08T18:00:00Z", { "exec_result->created->>id": "set-new", "exec_result->created->>status": "PAUSED" }),
    ];
    const busy = Array.from({ length: 25 }, (_, k) => ({ object_id: "set-busy", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: `2026-09-26T${String(k).padStart(2, "0")}:00:00Z` }));
    tables.ad_object_changes = [...busy, { object_id: "set-new", platform: "meta", change_kind: "status", after_status: "ACTIVE", occurred_at: "2026-10-15T18:00:00Z" }];
    const d = deps(async () => nums(10, 0));
    await readOwnLaunchResults("t1", NOW, d);
    expect(d.spy).toHaveBeenCalledWith("set-new", "2026-10-16", "2026-10-18");
  });

  it("the Meta reader counts a pixel-only lead as a lead, on the account's clock", async () => {
    tables.channel_actions = [order("ca6", "meta_ads.duplicate_ad_set", "2026-10-10T18:00:00Z")];
    tables.ad_object_changes = [{ action_table: "channel_actions", action_id: "ca6", object_id: "copy-8", before_status: null, change_kind: "status", platform: "meta" }];
    fbGet.mockReset().mockImplementation(async (_t: string, path: string) =>
      path === "act_1"
        ? { timezone_name: ZONE }
        : { data: [{ spend: "50", clicks: "200", actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "5" }] }] },
    );
    const lines = await readOwnLaunchResults("t1", NOW);
    expect(fbGet).toHaveBeenCalledWith("t1", "copy-8/insights", expect.objectContaining({ time_range: JSON.stringify({ since: "2026-10-11", until: "2026-10-17" }) }));
    expect(lines[0]).toContain("5 leads ($10.00 each); 200 clicks");
  });

  it("must catch (SaaS on Google): an Autopilot-approved Google campaign is read on Google; a Google ad group says it could not be read, never silence", async () => {
    tables.channel_actions = [
      order("g1", "google_ads.create_campaign", "2026-10-10T18:00:00Z", { "body->>cgo_order_origin": null, title: "Trials search", "exec_result->created->>id": "9001", "exec_result->created->>status": "ENABLED" }),
      order("g2", "google_ads.create_ad_group", "2026-10-11T18:00:00Z", { "body->>cgo_order_origin": null, title: "Trials group", "exec_result->created->>id": "777", "exec_result->created->>status": "PAUSED" }),
      order("g3", "google_ads.create_campaign", "2026-10-12T18:00:00Z", { "body->>cgo_order_origin": null, title: "Trials unconfirmed", "exec_result->created->>id": "9002", "exec_result->created->>status": "UNVERIFIED" }),
    ];
    const calls: string[] = [];
    const d = {
      zone: async () => ZONE,
      read: async (p: string, c: string, id: string, since: string, until: string): Promise<LaunchNumbers> => {
        calls.push(`${p}:${c}:${id}:${since}:${until}`);
        return c === "google_ads.create_campaign" ? { spend: 300, conversions: 12, leads: null, clicks: null } : "unread";
      },
    };
    const lines = await readOwnLaunchResults("t1", NOW, d);
    expect(calls).toContain("google:google_ads.create_campaign:9001:2026-10-11:2026-10-17");
    expect(lines.find((l) => l.includes("Trials search"))).toContain("Autopilot (your approval) made the Google campaign");
    expect(lines.find((l) => l.includes("Trials search"))).toContain("$300.00 spent; 12 conversions ($25.00 each) (every conversion Google counts)");
    expect(lines.find((l) => l.includes("Trials group"))).toContain("could not read (no per-object reader for Google ad groups and ads)");
    expect(lines.find((l) => l.includes("Trials unconfirmed"))).toContain("could not read (its switch-on was not confirmed)");
    expect(calls.some((c) => c.includes(":9002:") || c.includes(":777:"))).toBe(false);
  });

  it("notes sit among the measured lines newest first, and wait for 3 whole account days", async () => {
    tables.channel_actions = [
      order("m1", "meta_ads.duplicate_ad_set", "2026-10-08T18:00:00Z", { title: "Older copy" }),
      order("g4", "google_ads.create_ad_group", "2026-10-14T18:00:00Z", { "body->>cgo_order_origin": null, title: "Newer group", "exec_result->created->>id": "781", "exec_result->created->>status": "PAUSED" }),
      order("g5", "google_ads.create_ad_group", "2026-10-18T18:00:00Z", { "body->>cgo_order_origin": null, title: "Too new group", "exec_result->created->>id": "782", "exec_result->created->>status": "PAUSED" }),
    ];
    tables.ad_object_changes = [{ action_table: "channel_actions", action_id: "m1", object_id: "copy-m1", before_status: null, change_kind: "status", platform: "meta" }];
    const lines = await readOwnLaunchResults("t1", NOW, deps(async () => nums(10, 1)));
    expect(lines.map((l) => l.match(/"([^"]+)"/)?.[1])).toEqual(["Newer group", "Older copy"]);
  });

  it("notes keep the 14-day horizon, and an unknown zone never replaces their reason or shows a too-new one", async () => {
    tables.channel_actions = [
      order("g6", "google_ads.create_ad_group", "2026-10-01T18:00:00Z", { "body->>cgo_order_origin": null, title: "Old group", "exec_result->created->>id": "791", "exec_result->created->>status": "PAUSED" }),
      order("g7", "google_ads.create_ad_group", "2026-10-19T18:00:00Z", { "body->>cgo_order_origin": null, title: "New group", "exec_result->created->>id": "792", "exec_result->created->>status": "PAUSED" }),
      order("g10", "google_ads.create_ad_group", "2026-10-16T11:30:00Z", { "body->>cgo_order_origin": null, title: "96h group", "exec_result->created->>id": "795", "exec_result->created->>status": "PAUSED" }),
      order("g9", "google_ads.create_ad_group", "2026-10-17T11:00:00Z", { "body->>cgo_order_origin": null, title: "73h group", "exec_result->created->>id": "794", "exec_result->created->>status": "PAUSED" }),
      order("g8", "google_ads.create_ad_group", "2026-10-14T18:00:00Z", { "body->>cgo_order_origin": null, title: "Due group", "exec_result->created->>id": "793", "exec_result->created->>status": "PAUSED" }),
    ];
    const lines = await readOwnLaunchResults("t1", NOW, { zone: async () => Promise.reject(new Error("no zone")), read: async () => null });
    expect(lines).toEqual([expect.stringContaining('"Due group" -> could not read (no per-object reader for Google ad groups and ads)')]);
  });

  it("a platform read that fails says so on that line only", async () => {
    tables.channel_actions = [order("ca3", "meta_ads.create_ad", "2026-10-10T18:00:00Z", { "exec_result->created->>id": "ad-9", "exec_result->created->>status": "ACTIVE" })];
    const lines = await readOwnLaunchResults("t1", NOW, deps(async () => Promise.reject(new Error("Graph 500"))));
    expect(lines[0]).toContain("could not read");
  });
});
