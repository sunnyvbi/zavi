import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn(), staffCrossTenantClient: vi.fn() }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: vi.fn() }));
vi.mock("@/services/connectors/email-campaign/sendgrid-account", () => ({ resolveSendgridAccount: vi.fn() }));
vi.mock("@/services/email-test-lists/lists", () => ({ liveToolCaller: vi.fn() }));

import { fromObservations, fromResult, newestPer, OBSERVATIONS_PER_ACCOUNT, recomputeLearnings, RESULTS_PER_STRATUM, type ObservationRow, type ResultRow } from "../recompute";
import { readToolHistory, SEED_CAP, SeedStopped, seedLearnings, type SeedDeps } from "../seed";
import { runEmailLearnPass, type LearnPassDeps, type WorkRow } from "../worker";
import type { ProviderCall } from "@/services/connectors/email-campaign/providers";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const result = (over: Partial<ResultRow> = {}): ResultRow => ({
  id: "r1",
  route: "mailchimp",
  provider_ref: "c1",
  account_ref: { kind: "composio", connected_account_id: "ca-1" },
  list_id: "L1",
  list_name: "Newsletter",
  subject: "3 tips",
  started_at: "2026-09-01T14:00:00Z",
  finished_at: "2026-09-01T14:05:00Z",
  shared_tag: false,
  verdict: "beat",
  d7: { delivered: 900, clicks: 30, visitors: 12, provider_status: "ok", ga_status: "ok", opens: 400 },
  ...over,
});

describe("eligible rows", () => {
  it("a beat/below day-7 row gives clicks and visitors; never opens", () => {
    const o = fromResult(T, result());
    expect(o.map((x) => [x.metric, x.hits, x.delivered, x.window, x.account_key])).toEqual([
      ["visitors", 12, 900, "d7", "mailchimp:ca-1"],
      ["clicks", 30, 900, "d7", "mailchimp:ca-1"],
    ]);
  });

  it("must catch: baseline / no_signal / unknown, zero delivered: nothing", () => {
    for (const verdict of ["baseline", "no_signal", "unknown", null]) expect(fromResult(T, result({ verdict }))).toEqual([]);
    expect(fromResult(T, result({ d7: { ...result().d7, delivered: 0 } }))).toEqual([]);
  });

  it("a number carried from the 1-hour check leaves out only that metric; a carried delivered count leaves out all", () => {
    expect(fromResult(T, result({ d7: { ...result().d7, from_h1: ["clicks"] } })).map((x) => x.metric)).toEqual(["visitors"]);
    expect(fromResult(T, result({ d7: { ...result().d7, from_h1: ["opens"] } })).map((x) => x.metric)).toEqual(["visitors", "clicks"]);
    expect(fromResult(T, result({ d7: { ...result().d7, from_h1: ["delivered", "clicks"] } }))).toEqual([]);
  });

  it("visitors need GA ok and an unshared tag; clicks need the tool read ok", () => {
    expect(fromResult(T, result({ shared_tag: true })).map((x) => x.metric)).toEqual(["clicks"]);
    expect(fromResult(T, result({ d7: { ...result().d7, ga_status: "not_connected" } })).map((x) => x.metric)).toEqual(["clicks"]);
    expect(fromResult(T, result({ d7: { ...result().d7, provider_status: "could_not_read" } })).map((x) => x.metric)).toEqual(["visitors"]);
  });

  it("a stamp whose start equals finish is not a send time", () => {
    expect(fromResult(T, result({ started_at: "2026-09-01T14:05:00Z" }))[0].exact_time).toBe(false);
  });

  it("the same campaign in the seed and as a Zavi row: the Zavi row wins", () => {
    const obsRow = (id: string): ObservationRow => ({ account_key: "mailchimp:ca-1", route: "mailchimp", campaign_id: id, list_id: "L1", list_name: "N", subject: "s", sent_at: "2026-08-01T10:00:00Z", delivered: 100, clicks: 3 });
    const kept = fromObservations([obsRow("c1"), obsRow("c2"), { ...obsRow("c3"), clicks: null }], new Set(["mailchimp:ca-1|mailchimp|c1"]));
    expect(kept.map((k) => k.key)).toEqual(["obs:mailchimp:c2"]);
  });

  it("caps per stratum and per account, never one global limit (a busy list cannot starve another)", async () => {
    expect(RESULTS_PER_STRATUM).toBe(30);
    expect(OBSERVATIONS_PER_ACCOUNT).toBe(20);
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => ({ k: "busy", at: `2026-09-${String(10 + (i % 20)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z` })),
      ...Array.from({ length: 5 }, (_, i) => ({ k: "quiet", at: `2026-08-0${i + 1}T00:00:00Z` })),
    ];
    const kept = newestPer(rows, (r) => r.k, (r) => r.at, 30);
    expect(kept.filter((r) => r.k === "busy").length).toBe(30);
    expect(kept.filter((r) => r.k === "quiet").length).toBe(5);
    const oldestBusyKept = kept.filter((r) => r.k === "busy").map((r) => r.at).sort()[0];
    expect(rows.filter((r) => r.k === "busy" && r.at > oldestBusyKept).length).toBeLessThanOrEqual(29);
  });

  it("a recompute hands every topic and the connected accounts to the SQL rules", async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    const rows = Array.from({ length: 6 }, (_, i) =>
      result({ id: `r${i}`, provider_ref: `c${i}`, subject: i < 3 ? `${i} tips` : "Tips", d7: { delivered: 1000, clicks: i < 3 ? 50 : 10, provider_status: "ok" } }),
    );
    const out = await recomputeLearnings(T, {
      inputs: async () => ({ results: rows, observations: [] }),
      timeZone: async () => "UTC",
      connected: async () => ["mailchimp:ca-1"],
      apply,
    });
    expect(out.topics).toBeGreaterThan(0);
    const [, topics, connected] = apply.mock.calls[0] as unknown as [string, Array<{ split: string; holds: boolean }>, string[]];
    expect(topics.find((t) => t.split === "subject_digit")?.holds).toBe(true);
    expect(connected).toEqual(["mailchimp:ca-1"]);
  });
});

describe("the seed", () => {
  const fakeMailchimp = () => {
    const campaigns = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      status: "sent",
      send_time: new Date(Date.UTC(2026, 8, 30 - i, 15)).toISOString(),
      settings: { subject_line: `Subject ${i}`, title: `t${i}` },
      recipients: { list_id: "L1", ...(i === 1 ? { segment_opts: { saved_segment_id: 7 } } : {}) },
      emails_sent: 500,
    }));
    const calls: string[] = [];
    const call: ProviderCall = async (slug, args) => {
      calls.push(slug);
      const a = args as Record<string, unknown>;
      if (slug === "MAILCHIMP_LIST_CAMPAIGNS") {
        const off = Number(a.offset ?? 0);
        const page = campaigns.slice(off, off + Number(a.count));
        return { ok: true, status: 200, error: null, outcome_unknown: false, data: { campaigns: page, total_items: campaigns.length } };
      }
      if (slug === "MAILCHIMP_GET_LIST_INFO") return { ok: true, status: 200, error: null, outcome_unknown: false, data: { id: "L1", name: "Newsletter", stats: { member_count: 500 } } };
      if (slug === "MAILCHIMP_GET_CAMPAIGN_REPORT") return { ok: true, status: 200, error: null, outcome_unknown: false, data: { emails_sent: 500, bounces: { hard_bounces: 5 }, opens: { unique_opens: 100 }, clicks: { unique_subscriber_clicks: 12 } } };
      return { ok: false, status: 404, error: "not found", outcome_unknown: false, data: null };
    };
    return { call, calls };
  };

  it("must catch: at most 20 per tool, newest first, a segment send skipped; counts only", async () => {
    const { call, calls } = fakeMailchimp();
    const { rows, complete } = await readToolHistory("mailchimp", call, "mailchimp:ca-1", new Date("2026-10-12T00:00:00Z"));
    expect(SEED_CAP).toBe(20);
    expect(rows.length).toBe(20);
    expect(complete).toBe(true);
    expect(rows[0]).toMatchObject({ campaign_id: "m0", list_name: "Newsletter", delivered: 495, clicks: 12, subject: "Subject 0" });
    expect(rows.find((r) => r.campaign_id === "m1")).toBeUndefined();
    expect(calls.filter((c) => c === "MAILCHIMP_LIST_CAMPAIGNS").length).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/@/);
  });

  const seedDeps = (over: Partial<SeedDeps> = {}): SeedDeps & { recorded: unknown[]; sourced: unknown[] } => {
    const recorded: unknown[] = [];
    const sourced: unknown[] = [];
    return {
      recorded,
      sourced,
      accountKey: async (_t, tool) => (tool === "mailchimp" ? "mailchimp:ca-1" : null),
      caller: async () => fakeMailchimp().call,
      busy: async () => false,
      record: async (_t, rows) => void recorded.push(...rows),
      sources: async (_t, s, seeded, current, authoritative) => void sourced.push({ s, seeded, current, authoritative }),
      now: () => new Date("2026-10-12T00:00:00Z"),
      ...over,
    };
  };

  it("reads each connected tool once and records where it read from", async () => {
    const d = seedDeps();
    const out = await seedLearnings(T, d);
    expect(out.complete).toBe(true);
    expect(d.recorded.length).toBe(20);
    expect(d.sourced[0]).toMatchObject({ seeded: true, s: { "mailchimp:ca-1": { route: "mailchimp", status: "ok", count: 20 } } });
  });

  it("must catch E2: a connection lookup that fails prunes nothing (the sources are merged, not replaced)", async () => {
    const d = seedDeps({
      accountKey: async (_t, tool) => {
        if (tool === "klaviyo") throw new Error("connector read failed");
        return tool === "mailchimp" ? "mailchimp:ca-1" : null;
      },
    });
    await seedLearnings(T, d);
    expect(d.sourced[0]).toMatchObject({ current: ["mailchimp:ca-1"], authoritative: false, seeded: false });
    const ok = seedDeps();
    await seedLearnings(T, ok);
    expect(ok.sourced[0]).toMatchObject({ current: ["mailchimp:ca-1"], authoritative: true });
  });

  it("an account the results worker is reading now is not touched: busy, retried later", async () => {
    const caller = vi.fn();
    const d = seedDeps({ busy: async () => true, caller });
    const out = await seedLearnings(T, d);
    expect(out.complete).toBe(false);
    expect(caller).not.toHaveBeenCalled();
    expect(d.sourced[0]).toMatchObject({ seeded: false, s: { "mailchimp:ca-1": { status: "busy" } } });
  });

  it("a read stopped by the pass's budget is partial, never ok, and the campaigns already counted are kept", async () => {
    const d = seedDeps();
    let n = 0;
    const out = await seedLearnings(T, d, async () => {
      if (++n > 3 + 4) throw new SeedStopped("budget");
    });
    expect(out).toMatchObject({ complete: false, stopped: "budget" });
    expect(d.recorded.length).toBeGreaterThan(0);
    expect(d.recorded.length).toBeLessThan(20);
    expect(d.sourced[0]).toMatchObject({ seeded: false, s: { "mailchimp:ca-1": { status: "partial" } } });
  });

  it("must catch: a lost lease writes nothing at all, not even what was read; a lease lost right before the write too", async () => {
    const d = seedDeps();
    let n = 0;
    const out = await seedLearnings(T, d, async () => {
      if (++n > 6) throw new SeedStopped("lease_lost");
    });
    expect(out).toMatchObject({ stopped: "lease_lost" });
    expect(d.recorded).toEqual([]);
    expect(d.sourced).toEqual([]);
    const d2 = seedDeps();
    const out2 = await seedLearnings(T, d2, async () => undefined, async () => false);
    expect(out2).toMatchObject({ stopped: "lease_lost" });
    expect(d2.recorded).toEqual([]);
    expect(d2.sourced).toEqual([]);
  });

  it("the sources keep only accounts connected now", async () => {
    const d = seedDeps();
    const current: string[][] = [];
    d.sources = async (_t, _s, _seeded, cur) => void current.push(cur);
    await seedLearnings(T, d);
    expect(current[0]).toEqual(["mailchimp:ca-1"]);
  });

  it("a window with fewer than 20 usable campaigns, read to its end, is complete", async () => {
    const call: ProviderCall = async (slug) => {
      if (slug === "MAILCHIMP_LIST_CAMPAIGNS")
        return { ok: true, status: 200, error: null, outcome_unknown: false, data: { campaigns: [{ id: "x1", status: "sent", send_time: "2026-10-01T15:00:00Z", settings: { subject_line: "S" }, recipients: { list_id: "L1" } }], total_items: 1 } };
      if (slug === "MAILCHIMP_GET_LIST_INFO") return { ok: true, status: 200, error: null, outcome_unknown: false, data: { id: "L1", name: "N", stats: {} } };
      return { ok: true, status: 200, error: null, outcome_unknown: false, data: { emails_sent: 10, bounces: { hard_bounces: 0 }, clicks: { unique_subscriber_clicks: 1 }, opens: {} } };
    };
    const r = await readToolHistory("mailchimp", call, "mailchimp:ca-1", new Date("2026-10-12T00:00:00Z"));
    expect(r).toMatchObject({ complete: true, rows: [{ campaign_id: "x1" }] });
  });

  it("a tool that cannot be read: recorded as could not read, the work comes back", async () => {
    const d = seedDeps({ caller: async () => (async () => ({ ok: false, status: 500, error: "down", outcome_unknown: false, data: null })) as ProviderCall });
    const out = await seedLearnings(T, d);
    expect(out.complete).toBe(false);
    expect(d.sourced[0]).toMatchObject({ s: { "mailchimp:ca-1": { status: "could_not_read" } } });
  });
});

describe("the pass", () => {
  const row = (tenant: string, kind: "result" | "seed", id: string): WorkRow => ({ id, tenant_id: tenant, kind, dedupe_key: id, lease_token: `tok-${id}`, attempts: 0 });
  const passDeps = (rows: WorkRow[], over: Partial<LearnPassDeps> = {}) => {
    const done: Array<{ tenant: string; ids: string[]; outcome: string }> = [];
    const order: string[] = [];
    const d: LearnPassDeps = {
      repair: async () => 2,
      claim: async () => rows,
      complete: async (tenant, rs, outcome) => (done.push({ tenant, ids: rs.map((r) => r.id), outcome }), rs.length),
      extend: async () => true,
      seed: async (t) => (order.push(`seed:${t}`), { complete: true }),
      recompute: async (t) => order.push(`recompute:${t}`),
      now: () => 0,
      ...over,
    };
    return { d, done, order };
  };

  it("one recompute per workspace for all its rows; a seed runs first; each row's tenant is its own", async () => {
    const { d, done, order } = passDeps([row("t1", "result", "a"), row("t1", "seed", "b"), row("t2", "result", "c"), row("t1", "result", "d")]);
    const out = await runEmailLearnPass(d);
    expect(out).toEqual({ repaired: 2, tenants: 2, failed: 0, released: 0 });
    expect(order).toEqual(["seed:t1", "recompute:t1", "recompute:t2"]);
    expect(done).toEqual([
      { tenant: "t1", ids: ["a", "d"], outcome: "done" },
      { tenant: "t1", ids: ["b"], outcome: "done" },
      { tenant: "t2", ids: ["c"], outcome: "done" },
    ]);
  });

  it("a failed recompute spends an attempt on that workspace's rows; others go on", async () => {
    const { d, done } = passDeps([row("t1", "result", "a"), row("t2", "result", "b")], {
      recompute: async (t) => {
        if (t === "t1") throw new Error("db down");
      },
    });
    const out = await runEmailLearnPass(d);
    expect(out.failed).toBe(1);
    expect(done).toEqual([
      { tenant: "t1", ids: ["a"], outcome: "failed" },
      { tenant: "t2", ids: ["b"], outcome: "done" },
    ]);
  });

  it("an incomplete seed comes back; the result rows of the same pass are done", async () => {
    const { d, done } = passDeps([row("t1", "result", "a"), row("t1", "seed", "b")], { seed: async () => ({ complete: false }) });
    await runEmailLearnPass(d);
    expect(done).toEqual([
      { tenant: "t1", ids: ["a"], outcome: "done" },
      { tenant: "t1", ids: ["b"], outcome: "failed" },
    ]);
  });

  it("must catch: out of time, the workspaces not started are RELEASED (no attempt spent), never failed", async () => {
    let t = 0;
    const { d, done } = passDeps([row("t1", "result", "a"), row("t2", "result", "b")], {
      now: () => t,
      recompute: async () => {
        t += 5 * 60_000;
      },
    });
    const out = await runEmailLearnPass(d);
    expect(out.released).toBe(1);
    expect(done).toEqual([
      { tenant: "t1", ids: ["a"], outcome: "done" },
      { tenant: "t2", ids: ["b"], outcome: "released" },
    ]);
  });

  it("a seed cut short by the budget: what it read is kept (by the seed), and every row of that workspace is RELEASED", async () => {
    const { d, done, order } = passDeps([row("t1", "result", "a"), row("t1", "seed", "b")], { seed: async () => ({ complete: false, stopped: "budget" as const }) });
    const out = await runEmailLearnPass(d);
    expect(out.released).toBe(1);
    expect(order).toEqual([]);
    expect(done).toEqual([{ tenant: "t1", ids: ["a", "b"], outcome: "released" }]);
  });

  it("must catch: a seed whose lease was lost writes NOTHING more (no recompute, no completion)", async () => {
    const { d, done, order } = passDeps([row("t1", "seed", "b")], { seed: async () => ({ complete: false, stopped: "lease_lost" as const }) });
    await runEmailLearnPass(d);
    expect(order).toEqual([]);
    expect(done).toEqual([]);
  });

  it("a long seed re-leases its rows (heartbeat) and a lost lease stops it as lease_lost", async () => {
    let t = 0;
    const extend = vi.fn(async () => false);
    let reason: string | null = null;
    const { d } = passDeps([row("t1", "seed", "s")], {
      now: () => t,
      extend,
      seed: async (_tenant, guard) => {
        t += 3 * 60_000;
        try {
          await guard();
        } catch (e) {
          reason = e instanceof SeedStopped ? e.reason : null;
        }
        return { complete: false, stopped: "lease_lost" as const };
      },
    });
    await runEmailLearnPass(d);
    expect(extend).toHaveBeenCalledTimes(1);
    expect(reason).toBe("lease_lost");
  });

  it("a completion that changes no row was not ours: logged, nothing else", async () => {
    const log = vi.fn();
    const { d } = passDeps([row("t1", "result", "a")], { complete: async () => 0, log });
    await runEmailLearnPass(d);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no longer this pass's/));
  });
});
