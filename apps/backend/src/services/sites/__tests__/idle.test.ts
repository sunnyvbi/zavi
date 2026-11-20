
import { describe, it, expect } from "vitest";
import {
  sweepIdleSites,
  wakeSite,
  isIdle,
  parseLastSeen,
  WAKE_GLOBAL_BUCKET,
  WAKE_STALE_MS,
  type IdleDeps,
} from "../idle";
import { siteKv, type SiteRow, type SiteStatus, type SiteStore } from "../contract";
import { SupabaseMgmtError } from "../supabase-mgmt";
import { APP_SETTINGS } from "@/services/settings/registry";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let idn = 0;
function site(over: Partial<SiteRow> = {}): SiteRow {
  idn += 1;
  const id = `0000000${idn}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`.slice(-36);
  return {
    id, tenant_id: T1, root_conductor_run_id: null, started_by_user_id: null, owner_email: "owner@example.com",
    label: `s${idn}`, hostname: `s${idn}.zaviagent.com`, github_full_name: null, supabase_project_ref: "projref000000000001",
    supabase_url: null, status: "live", live_url: null, desired_sha: null, live_sha: null, live_deploy_id: null,
    last_visit_at: null, last_edit_at: null, paused_at: null, last_error: null,
    created_at: iso(NOW - 60 * DAY), updated_at: iso(NOW - 60 * DAY), ...over,
  };
}

function harness(rows: SiteRow[]) {
  const sites = new Map(rows.map((r) => [r.id, r]));
  const kv = new Map<string, string>();
  const emails: Array<{ to: string; subject: string }> = [];
  const calls = { pause: 0, restore: 0 };
  const counters = new Map<string, number>();
  let now = NOW;
  const fail = { pause: false, restore: false, kvPut: false, ledger: false };
  let restoreGate: Promise<void> | null = null;
  const pauseWith: { outcome: "paused" | "unsupported" | "no_project"; error: Error | null } = { outcome: "paused", error: null };

  const store: SiteStore = {
    getOrCreateForRun: async () => { throw new Error("unused"); },
    get: async (t, id) => { const s = sites.get(id); return s && s.tenant_id === t ? { ...s } : null; },
    getByRun: async () => null,
    getByRepo: async () => null,
    listForTenant: async () => [],
    update: async (t, id, patch) => {
      const s = sites.get(id)!;
      if (s.tenant_id !== t) throw new Error("tenant");
      Object.assign(s, patch, { updated_at: iso(now) });
      return { ...s };
    },
    transition: async (t, id, from: SiteStatus[], to: SiteStatus, patch = {}) => {
      const s = sites.get(id);
      if (!s || s.tenant_id !== t || !from.includes(s.status)) return null;
      Object.assign(s, patch, { status: to, updated_at: iso(now) });
      return { ...s };
    },
    settleStopped: async () => null,
    activateIfDesired: async () => false,
    claimProvider: async () => {},
    setProviderState: async () => {},
    scheduleProviderDelete: async () => { throw new Error("idle never schedules a deletion"); },
    cancelProviderDelete: async () => { throw new Error("idle never cancels a deletion"); },
    beginProviderDelete: async () => { throw new Error("idle never deletes"); },
  };

  const deps: IdleDeps = {
    store,
    resolver: {
      byHostname: async (h) => {
        const s = [...sites.values()].find((x) => x.hostname === h);
        return s ? { tenant_id: s.tenant_id, site_id: s.id, status: s.status } : null;
      },
      byRepo: async () => null,
      claimIdleBatch: async (cutoff, limit) =>
        [...sites.values()]
          .filter((s) => s.status === "live" && isIdle(s, Date.parse(cutoff)))
          .slice(0, limit)
          .map((s) => ({ tenant_id: s.tenant_id, site_id: s.id, hostname: s.hostname })),
    },
    provisioner: {
      pause: async () => {
        calls.pause += 1;
        if (fail.pause) throw new Error("pause failed (500)");
        if (pauseWith.error) throw pauseWith.error;
        return pauseWith.outcome;
      },
      restore: async () => {
        calls.restore += 1;
        if (restoreGate) await restoreGate;
        if (fail.restore) throw new Error("restore failed (500)");
      },
    },
    kv: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => { if (fail.kvPut) throw new Error("kv write failed (500)"); kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
    ownerEmail: async () => "fallback@example.com",
    sendEmail: async (to, subject) => { emails.push({ to, subject }); },
    tickGlobal: async (key, limit) => {
      if (fail.ledger) throw new Error("ledger down");
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n <= limit;
    },
    tickSite: async (t, s, limit) => {
      const key = `tenant:${t}:site_wake:${s}`;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n <= limit;
    },
    now: () => now,
    wakeGlobalPerHour: 3,
    wakeSitePerHour: 10,
    log: () => {},
  };
  return {
    deps, sites, kv, emails, calls, counters, fail, pauseWith,
    setNow: (n: number) => { now = n; },
    gateRestore: () => { let open!: () => void; restoreGate = new Promise((r) => { open = r; }); return () => open(); },
  };
}

describe("isIdle / parseLastSeen", () => {
  const cutoff = NOW - 30 * DAY;
  it("null timestamps fall back to created_at", () => {
    expect(isIdle({ created_at: iso(NOW - 31 * DAY), last_visit_at: null, last_edit_at: null }, cutoff)).toBe(true);
    expect(isIdle({ created_at: iso(NOW - 29 * DAY), last_visit_at: null, last_edit_at: null }, cutoff)).toBe(false);
  });
  it("only BOTH older than 30 days is idle", () => {
    const created_at = iso(NOW - 90 * DAY);
    expect(isIdle({ created_at, last_visit_at: iso(NOW - 40 * DAY), last_edit_at: iso(NOW - 2 * DAY) }, cutoff)).toBe(false);
    expect(isIdle({ created_at, last_visit_at: iso(NOW - 2 * DAY), last_edit_at: iso(NOW - 40 * DAY) }, cutoff)).toBe(false);
    expect(isIdle({ created_at, last_visit_at: iso(NOW - 40 * DAY), last_edit_at: iso(NOW - 40 * DAY) }, cutoff)).toBe(true);
  });
  it("parses ms, seconds and ISO", () => {
    expect(parseLastSeen(String(NOW))).toBe(NOW);
    expect(parseLastSeen(String(NOW / 1000))).toBe(NOW);
    expect(parseLastSeen(iso(NOW))).toBe(NOW);
    expect(parseLastSeen("junk")).toBeNull();
    expect(parseLastSeen(null)).toBeNull();
  });
});

describe("sweepIdleSites", () => {
  it("pauses only sites idle on BOTH axes, sets the KV flag and emails the owner once", async () => {
    const idle = site();
    const edited = site({ last_edit_at: iso(NOW - 3 * DAY) });
    const young = site({ created_at: iso(NOW - 5 * DAY) });
    const h = harness([idle, edited, young]);
    const r = await sweepIdleSites(h.deps);
    expect(r.paused).toBe(1);
    expect(h.sites.get(idle.id)!.status).toBe("paused");
    expect(h.sites.get(idle.id)!.paused_at).toBe(iso(NOW));
    expect(h.sites.get(edited.id)!.status).toBe("live");
    expect(h.sites.get(young.id)!.status).toBe("live");
    expect(h.kv.get(siteKv.paused(idle.hostname))).toBe("1");
    expect(h.emails).toEqual([{ to: "owner@example.com", subject: `${idle.hostname} is paused` }]);

    await sweepIdleSites(h.deps);
    expect(h.emails).toHaveLength(1);
    expect(h.calls.pause).toBe(1);
  });

  it("a recent KV visit mark is folded into last_visit_at and keeps the site live", async () => {
    const s = site();
    const h = harness([s]);
    h.kv.set(siteKv.lastSeen(s.hostname), String(NOW - 2 * DAY));
    const r = await sweepIdleSites(h.deps);
    expect(r.paused).toBe(0);
    expect(r.visited).toBe(1);
    expect(h.sites.get(s.id)!.status).toBe("live");
    expect(h.sites.get(s.id)!.last_visit_at).toBe(iso(NOW - 2 * DAY));
  });

  it("falls back to the tenant owner's address when the site has none", async () => {
    const s = site({ owner_email: null });
    const h = harness([s]);
    await sweepIdleSites(h.deps);
    expect(h.emails[0].to).toBe("fallback@example.com");
  });

  it("an ambiguous pause error keeps the site paused with its flag, so the next visit wakes it (review F4)", async () => {
    const s = site();
    const h = harness([s]);
    h.fail.pause = true;
    const r = await sweepIdleSites(h.deps);
    expect(r.failed).toBe(1);
    expect(h.sites.get(s.id)!.status).toBe("paused");
    expect(h.sites.get(s.id)!.last_error).toMatch(/pause uncertain/);
    expect(h.kv.has(siteKv.paused(s.hostname))).toBe(true);
    expect(h.emails).toHaveLength(0);
  });

  it("a KV read error never pauses a site: it is skipped and retried next sweep (review F3)", async () => {
    const s = site();
    const h = harness([s]);
    h.deps.kv.get = async () => { throw new Error("kv read failed (500)"); };
    const r = await sweepIdleSites(h.deps);
    expect(r.failed).toBe(1);
    expect(r.paused).toBe(0);
    expect(h.sites.get(s.id)!.status).toBe("live");
  });

  it("a KV write failure never pauses the project", async () => {
    const s = site();
    const h = harness([s]);
    h.fail.kvPut = true;
    await sweepIdleSites(h.deps);
    expect(h.calls.pause).toBe(0);
    expect(h.sites.get(s.id)!.status).toBe("live");
  });

  it("a paid org refusing the pause leaves the site live and un-gated, sends no mail, and stops the sweep", async () => {
    const a = site();
    const b = site();
    const h = harness([a, b]);
    h.pauseWith.outcome = "unsupported";
    const r = await sweepIdleSites(h.deps);
    expect(r).toMatchObject({ paused: 0, refused: 1, stopped: "pause_unsupported" });
    expect(h.calls.pause).toBe(1);
    for (const s of [a, b]) {
      expect(h.sites.get(s.id)!.status).toBe("live");
      expect(h.sites.get(s.id)!.paused_at).toBeNull();
      expect(h.kv.has(siteKv.paused(s.hostname))).toBe(false);
    }
    expect(h.sites.get(a.id)!.last_error).toMatch(/not applied: unsupported/);
    expect(h.emails).toHaveLength(0);
  });

  it("a definite 4xx refusal leaves the site live and un-gated with no mail (the sweep goes on)", async () => {
    const a = site();
    const b = site();
    const h = harness([a, b]);
    h.pauseWith.error = new SupabaseMgmtError("pause project", 400);
    const r = await sweepIdleSites(h.deps);
    expect(r).toMatchObject({ paused: 0, refused: 2, failed: 0 });
    expect(r.stopped).toBeUndefined();
    for (const s of [a, b]) {
      expect(h.sites.get(s.id)!.status).toBe("live");
      expect(h.kv.has(siteKv.paused(s.hostname))).toBe(false);
    }
    expect(h.emails).toHaveLength(0);
  });

  it("a 5xx / rate-limited pause is still ambiguous: the site stays paused for the wake path", async () => {
    const s = site();
    const h = harness([s]);
    h.pauseWith.error = new SupabaseMgmtError("pause project", 429);
    const r = await sweepIdleSites(h.deps);
    expect(r).toMatchObject({ failed: 1, refused: 0 });
    expect(h.sites.get(s.id)!.status).toBe("paused");
    expect(h.emails).toHaveLength(0);
  });

  it("a site whose project is gone (no_project) goes back to live, un-gated", async () => {
    const s = site();
    const h = harness([s]);
    h.pauseWith.outcome = "no_project";
    await sweepIdleSites(h.deps);
    expect(h.sites.get(s.id)!.status).toBe("live");
    expect(h.kv.has(siteKv.paused(s.hostname))).toBe(false);
    expect(h.emails).toHaveLength(0);
  });

  it("a pooled site (no project of its own) is never claimed or gated", async () => {
    const s = site({ supabase_project_ref: null });
    const h = harness([s]);
    const r = await sweepIdleSites(h.deps);
    expect(r).toMatchObject({ paused: 0, skipped: 1 });
    expect(h.calls.pause).toBe(0);
    expect(h.sites.get(s.id)!.status).toBe("live");
    expect(h.kv.has(siteKv.paused(s.hostname))).toBe(false);
  });

  it("site_idle_pause_enabled is a global setting, OFF by default (paid orgs cannot pause)", () => {
    expect(APP_SETTINGS.site_idle_pause_enabled).toMatchObject({ type: "boolean", scope: "global", defaultValue: false });
  });

  it("does nothing at all while site_idle_pause_enabled is off", async () => {
    const s = site();
    const h = harness([s]);
    let claimed = 0;
    const claim = h.deps.resolver.claimIdleBatch;
    h.deps.resolver.claimIdleBatch = async (c, l) => { claimed += 1; return claim(c, l); };
    h.deps.pauseEnabled = async () => false;
    const r = await sweepIdleSites(h.deps);
    expect(r).toMatchObject({ considered: 0, paused: 0, stopped: "disabled" });
    expect(claimed).toBe(0);
    expect(h.calls.pause).toBe(0);
    expect(h.sites.get(s.id)!.status).toBe("live");
    h.deps.pauseEnabled = async () => true;
    expect((await sweepIdleSites(h.deps)).paused).toBe(1);
    expect(h.emails).toHaveLength(1);
  });

  it("terminates when a site keeps failing (no infinite re-claim)", async () => {
    const h = harness([site(), site()]);
    h.fail.pause = true;
    const r = await sweepIdleSites(h.deps);
    expect(r.considered).toBe(2);
  });
});

describe("wakeSite", () => {
  it("unknown host answers unknown; a live host answers live", async () => {
    const s = site();
    const h = harness([s]);
    expect((await wakeSite("nope.zaviagent.com", h.deps)).status).toBe("unknown");
    expect((await wakeSite(s.hostname, h.deps)).status).toBe("live");
    expect(h.calls.restore).toBe(0);
  });

  it("restores a paused site, goes live and clears the KV flag", async () => {
    const s = site({ status: "paused" });
    const h = harness([s]);
    h.kv.set(siteKv.paused(s.hostname), "1");
    const r = await wakeSite(s.hostname, h.deps);
    expect(r.status).toBe("waking");
    await r.done;
    expect(h.sites.get(s.id)!.status).toBe("live");
    expect(h.sites.get(s.id)!.paused_at).toBeNull();
    expect(h.kv.has(siteKv.paused(s.hostname))).toBe(false);
  });

  it("concurrent wakes restore exactly once", async () => {
    const s = site({ status: "paused" });
    const h = harness([s]);
    const open = h.gateRestore();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => wakeSite(s.hostname, h.deps)));
    open();
    await Promise.all(results.map((r) => r.done));
    expect(h.calls.restore).toBe(1);
    expect(results.every((r) => r.status === "waking")).toBe(true);
    expect(results.filter((r) => r.done).length).toBe(1);
    expect(h.sites.get(s.id)!.status).toBe("live");
  });

  it("enforces the persisted global budget across sites", async () => {
    const rows = [1, 2, 3, 4].map(() => site({ status: "paused" }));
    const h = harness(rows);
    const out = [];
    for (const r of rows) {
      const w = await wakeSite(r.hostname, h.deps);
      await w.done;
      out.push(w.status);
    }
    expect(out).toEqual(["waking", "waking", "waking", "paused"]);
    expect(h.calls.restore).toBe(3);
    expect(h.counters.get(WAKE_GLOBAL_BUCKET)).toBe(4);
    const last = h.sites.get(rows[3].id)!;
    expect(last.status).toBe("paused");
    expect(last.last_error).toMatch(/budget/);
  });

  it("a ledger error fails closed (stays paused, no restore)", async () => {
    const s = site({ status: "paused" });
    const h = harness([s]);
    h.fail.ledger = true;
    expect((await wakeSite(s.hostname, h.deps)).status).toBe("paused");
    expect(h.calls.restore).toBe(0);
    expect(h.sites.get(s.id)!.status).toBe("paused");
  });

  it("a restore failure goes back to paused with last_error, KV flag kept", async () => {
    const s = site({ status: "paused" });
    const h = harness([s]);
    h.kv.set(siteKv.paused(s.hostname), "1");
    h.fail.restore = true;
    const r = await wakeSite(s.hostname, h.deps);
    await r.done;
    expect(h.sites.get(s.id)!.status).toBe("paused");
    expect(h.sites.get(s.id)!.last_error).toMatch(/wake failed/);
    expect(h.kv.get(siteKv.paused(s.hostname))).toBe("1");
  });

  it("a waking row left by a crashed process is re-claimed only once stale", async () => {
    const s = site({ status: "waking", updated_at: iso(NOW - 60_000) });
    const h = harness([s]);
    expect((await wakeSite(s.hostname, h.deps)).status).toBe("waking");
    expect(h.calls.restore).toBe(0);
    h.setNow(NOW + WAKE_STALE_MS + 60_000);
    const r = await wakeSite(s.hostname, h.deps);
    await r.done;
    expect(h.calls.restore).toBe(1);
    expect(h.sites.get(s.id)!.status).toBe("live");
  });

  it("a site in another state is reported, never restored", async () => {
    const s = site({ status: "building", tenant_id: T2 });
    const h = harness([s]);
    expect((await wakeSite(s.hostname, h.deps)).status).toBe("building");
    expect(h.calls.restore).toBe(0);
  });
});
