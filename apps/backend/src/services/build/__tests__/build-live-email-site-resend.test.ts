
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  send: vi.fn(async (_a: { adminUrl: string; siteName: string; ownerLogin?: { email: string; mint: () => Promise<string> } | null }) => ({ sent: true })),
  ownerEmail: "owner@example.test" as string | null,
  ownerOn: true,
}));
vi.mock("@/services/tenant-client", () => ({ tenantClient: () => fakeSb(h.tables), asTenantId: (t: string) => t }));
vi.mock("@/email/sendAuthEmail", () => ({
  sendBuildLiveEmail: vi.fn(async () => ({ sent: true })),
  sendSiteAdminLoginEmail: h.send,
  resolveTenantOwnerEmail: vi.fn(async () => h.ownerEmail),
}));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async (key: string) => key === "build_auto_site_owner" && h.ownerOn) }));

import { resendOwnerLoginLink } from "../build-live-email";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function seed() {
  const g = (site: string) => [{ payload: { stage: "provision", site_id: site } }, { payload: { stage: "deploy", site_id: site } }];
  h.tables = {
    conductor_runs: [
      { id: "run-a", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x", goal_graph: g(A) },
      { id: "run-b", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Beta — y", goal_graph: g(B) },
      { id: "run-foreign", tenant_id: T2, kind: "build_app", status: "done", objective: "Build product: Other", goal_graph: g(A) },
    ],
  };
}

function store(over: Parameters<typeof siteRow>[0] | null = null) {
  return fakeSiteStore([
    siteRow({ id: A, label: "alpha", root_conductor_run_id: "run-a", status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com", ...(over ?? {}) }),
    siteRow({ id: B, label: "beta", root_conductor_run_id: "run-b", status: "live", live_deploy_id: "d2", live_url: "https://beta.zaviagent.com" }),
  ]).store;
}

function persistedThrottle() {
  const used = new Set<string>();
  return vi.fn(async (t: string, site: string) => {
    const k = `${t}|${site}`;
    if (used.has(k)) return false;
    used.add(k);
    return true;
  });
}

beforeEach(() => {
  seed();
  h.send.mockClear();
  h.ownerEmail = "owner@example.test";
  h.ownerOn = true;
});

describe("resendOwnerLoginLink for a new-flow site", () => {
  it("mails site A's own URL with a link minted before sending, for A only", async () => {
    let n = 0;
    const ownerMagicLink = vi.fn(async () => `https://ref.supabase.co/verify?token=t${++n}`);
    const tickOwnerLink = persistedThrottle();
    const out = await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink });
    expect(out).toEqual({ sent: true, email: "owner@example.test" });
    expect(ownerMagicLink).toHaveBeenCalledWith({ tenant_id: T1, site_id: A, owner_email: "owner@example.test", redirect_to: "https://alpha.zaviagent.com/admin" });
    const arg = h.send.mock.calls[0][0];
    expect(arg).toMatchObject({ adminUrl: "https://alpha.zaviagent.com/admin", siteName: "Alpha" });
    expect(await arg.ownerLogin!.mint()).toBe("https://ref.supabase.co/verify?token=t1");
    expect(tickOwnerLink).toHaveBeenCalledWith(T1, A);
    expect(JSON.stringify(out)).not.toContain("verify");
  });

  it("two sites in one tenant: each has its own throttle and its own link", async () => {
    const ownerMagicLink = vi.fn(async (i: { site_id: string }) => `https://ref.supabase.co/verify?site=${i.site_id}`);
    const tickOwnerLink = persistedThrottle();
    const s = store();
    expect((await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: s, ownerMagicLink, tickOwnerLink })).sent).toBe(true);
    expect((await resendOwnerLoginLink(T1, { conductor_run_id: "run-b" }, { store: s, ownerMagicLink, tickOwnerLink })).sent).toBe(true);
    expect(h.send.mock.calls.map((c) => c[0].adminUrl)).toEqual(["https://alpha.zaviagent.com/admin", "https://beta.zaviagent.com/admin"]);
    expect(ownerMagicLink.mock.calls.map((c) => c[0].site_id)).toEqual([A, B]);
  });

  it("the persisted throttle refuses a second send for the same site within 5 minutes, before minting", async () => {
    const ownerMagicLink = vi.fn(async () => "https://ref.supabase.co/verify?token=x");
    const tickOwnerLink = persistedThrottle();
    await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink });
    const again = await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink });
    expect(again).toEqual({ sent: false, reason: "cooldown", retryAfterS: 300 });
    expect(ownerMagicLink).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("each allowed send mints a NEW link (a fresh one supersedes the last)", async () => {
    let n = 0;
    const ownerMagicLink = vi.fn(async () => `https://ref.supabase.co/verify?token=t${++n}`);
    const allow = vi.fn(async () => true);
    await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: allow });
    await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: allow });
    expect(await h.send.mock.calls[0][0].ownerLogin!.mint()).toBe("https://ref.supabase.co/verify?token=t1");
    expect(await h.send.mock.calls[1][0].ownerLogin!.mint()).toBe("https://ref.supabase.co/verify?token=t2");
  });

  it("a foreign or unknown run resends nothing (never another tenant's site)", async () => {
    const ownerMagicLink = vi.fn();
    for (const id of ["run-foreign", "no-such-run"]) {
      expect(await resendOwnerLoginLink(T1, { conductor_run_id: id }, { store: store(), ownerMagicLink, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "no_live_site" });
    }
    expect(ownerMagicLink).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("no session, or an old-flow run (no site), resends nothing: tenant_resources is never read as an app", async () => {
    h.tables.conductor_runs.push({ id: "run-old", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Old", goal_graph: [{ payload: { stage: "build" } }] });
    h.tables.tenant_resources = [{ tenant_id: T1, resource_kind: "hosting", status: "ready", external_ref: { url: "https://old.onrender.com" } }];
    const ownerMagicLink = vi.fn();
    expect(await resendOwnerLoginLink(T1, {}, { store: store(), ownerMagicLink, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "no_live_site" });
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-old" }, { store: store(), ownerMagicLink, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "no_live_site" });
    expect(ownerMagicLink).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the feature switch off refuses as disabled", async () => {
    h.ownerOn = false;
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store() })).toEqual({ sent: false, reason: "disabled" });
  });

  it("a site with no activated live deploy, or paused, has no live site", async () => {
    for (const over of [{ id: A, live_deploy_id: null }, { id: A, status: "paused" as const }]) {
      expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(over), ownerMagicLink: vi.fn(), tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "no_live_site" });
    }
  });

  it("no owner, or an owner who is not the mail recipient, is not eligible and nothing is minted", async () => {
    const ownerMagicLink = vi.fn();
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store({ id: A, owner_email: null }), ownerMagicLink, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "not_eligible" });
    h.ownerEmail = "someone-else@example.test";
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "not_eligible" });
    expect(ownerMagicLink).not.toHaveBeenCalled();
  });

  it("a failed mint sends nothing; an unreadable throttle fails closed", async () => {
    const failMint = vi.fn(async () => {
      throw new Error("gotrue 500");
    });
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink: failMint, tickOwnerLink: vi.fn(async () => true) })).toEqual({ sent: false, reason: "send_failed" });
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink: vi.fn(), tickOwnerLink: vi.fn(async () => { throw new Error("rpc down"); }) })).toEqual({ sent: false, reason: "send_failed" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the throttle slot is given back when nothing went out, and kept only for a delivered link", async () => {
    const ownerMagicLink = vi.fn(async () => "https://ref.supabase.co/verify?token=t1");
    const tick = vi.fn(async () => true);
    const releaseOwnerLink = vi.fn(async () => {});
    const failMint = vi.fn(async () => {
      throw new Error("gotrue 500");
    });
    await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink: failMint, tickOwnerLink: tick, releaseOwnerLink });
    expect(releaseOwnerLink).toHaveBeenCalledTimes(1);
    h.send.mockRejectedValueOnce(new Error("sendgrid 503"));
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: tick, releaseOwnerLink })).toEqual({ sent: false, reason: "send_failed" });
    expect(releaseOwnerLink).toHaveBeenCalledTimes(2);
    h.send.mockResolvedValueOnce({ sent: false });
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: tick, releaseOwnerLink })).toEqual({ sent: false, reason: "send_failed" });
    expect(releaseOwnerLink).toHaveBeenCalledTimes(3);
    expect((await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink, tickOwnerLink: tick, releaseOwnerLink })).sent).toBe(true);
    expect(releaseOwnerLink).toHaveBeenCalledTimes(3);
    expect(releaseOwnerLink).toHaveBeenCalledWith(T1, A);
  });

  it("a failed send that outlived its cooldown window does not release (a newer click may hold the slot)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
      const releaseOwnerLink = vi.fn(async () => {});
      const slowFailMint = vi.fn(async () => {
        vi.setSystemTime(new Date("2026-10-02T10:06:00Z"));
        throw new Error("mint timeout");
      });
      expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink: slowFailMint, tickOwnerLink: vi.fn(async () => true), releaseOwnerLink })).toEqual({ sent: false, reason: "send_failed" });
      expect(releaseOwnerLink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a release that errors is retried once, then fails closed", async () => {
    const releaseOwnerLink = vi.fn(async () => {
      throw new Error("db down");
    });
    const failMint = vi.fn(async () => {
      throw new Error("mint 500");
    });
    expect(await resendOwnerLoginLink(T1, { conductor_run_id: "run-a" }, { store: store(), ownerMagicLink: failMint, tickOwnerLink: vi.fn(async () => true), releaseOwnerLink })).toEqual({ sent: false, reason: "send_failed" });
    expect(releaseOwnerLink).toHaveBeenCalledTimes(2);
  });
});
