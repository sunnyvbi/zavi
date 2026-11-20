
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "t-1";

type Run = {
  id: string;
  agent_slug: string;
  status: string;
  cron_dedupe_key: string;
  preview_action_types: string[] | null;
};

const h = vi.hoisted(() => ({
  runs: [] as Run[],
  open: [] as Array<{ run_id: string | null }>,
  alreadySent: false,
  sent: [] as Array<Record<string, unknown>>,
  flags: [] as unknown[],
  claimed: false,
  legacySent: false,
  sendImpl: null as null | (() => Promise<{ sent: boolean }>),
}));

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.update = (p: Record<string, unknown>) => {
      patch = p;
      return self;
    };
    self.eq = (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
      return self;
    };
    self.like = (k: string, pat: string) => {
      const prefix = pat.replace(/%$/, "");
      filters.push((r) => String(r[k] ?? "").startsWith(prefix));
      return self;
    };
    self.not = (k: string) => {
      filters.push((r) => r[k] !== null && r[k] !== undefined);
      return self;
    };
    self.is = (k: string) => {
      filters.push((r) => r[k] === null || r[k] === undefined);
      return self;
    };
    const run = () => {
      const src = (table === "agent_runs" ? h.runs : h.open) as unknown as Array<Record<string, unknown>>;
      const hit = src.filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null };
    };
    self.limit = async () => run();
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve);
    return self;
  };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: chain }) };
});
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => h.alreadySent,
  getBoolSettingStrict: async (key: string) => (key === "upgrade_actions_ready_email_sent" ? h.legacySent : h.claimed),
  claimTenantFlag: async () => {
    if (h.claimed) return false;
    h.claimed = true;
    return true;
  },
  setTenantSetting: async (...a: unknown[]) => {
    h.flags.push(a);
    if (a[1] === "results_email_claimed" && a[2] === null) h.claimed = false;
  },
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendUpgradeActionsReadyEmail: async (a: Record<string, unknown>) => {
    if (h.sendImpl) return h.sendImpl();
    h.sent.push(a);
    return { sent: true };
  },
}));
vi.mock("@/services/web-base", () => ({
  webBaseUrl: () => "https://www.zaviagent.com",
  channelUrl: (slug: string) => `https://www.zaviagent.com/workspace?tab=channels&channel=${slug}`,
}));
vi.mock("../auto-first-run", () => ({ startPreviewRun: vi.fn() }));
vi.mock("../preview-plan", () => ({ planIncludesChannel: vi.fn(), planIncludesChannelStrict: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const sends = vi.hoisted(() => [] as unknown[]);
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async (e: unknown) => { sends.push(e); }) } }));

import { maybeSendUpgradeActionsReadyEmail, requestPreviewUpgrade, rerunDryPreviews, rerunPreviewsOnUpgrade } from "../preview-upgrade";

const dry = (slug: string, status = "success"): Run => ({
  id: `dry-${slug}`,
  agent_slug: slug,
  status,
  cron_dedupe_key: `first-run-preview:${T}:${slug}`,
  preview_action_types: ["fix"],
});

beforeEach(() => {
  h.runs = [dry("seo"), dry("reddit_organic"), dry("geo", "running")];
  h.open = [];
  h.alreadySent = false;
  h.sent = [];
  h.flags = [];
  h.claimed = false;
  h.legacySent = false;
  h.sendImpl = null;
});

describe("rerunPreviewsOnUpgrade", () => {
  const ok = () =>
    vi.fn(async (_t: string, slug: string) => {
      h.runs.push({
        id: `real-${slug}`,
        agent_slug: slug,
        status: "queued",
        cron_dedupe_key: `first-run-preview:${T}:${slug}`,
        preview_action_types: null,
      });
      return { started: true as const };
    });
  const all = { planIncludes: async () => true };

  it("re-runs each finished dry preview the plan now includes, retiring its key first", async () => {
    const start = ok();
    const started = await rerunPreviewsOnUpgrade(T, { ...all, start });
    expect(started.sort()).toEqual(["reddit_organic", "seo"]);
    expect(h.runs.find((r) => r.id === "dry-seo")!.cron_dedupe_key).toBe(`first-run-preview-done:${T}:seo`);
    expect(h.runs.find((r) => r.id === "dry-geo")!.cron_dedupe_key).toBe(`first-run-preview:${T}:geo`);
  });

  it("claims the channel run under its own id, so the signup claim is not a duplicate", async () => {
    const start = ok();
    await rerunPreviewsOnUpgrade(T, { ...all, start });
    expect(start).toHaveBeenCalledWith(T, "seo", { claimSuffix: expect.stringMatching(/^:upgrade:[0-9a-f-]{36}$/) });
  });

  it("the shared loop (also the re-run script's) takes the caller's channel check and stops at maxStarts", async () => {
    const start = ok();
    const out = await rerunDryPreviews(T, { include: async (r) => r.agent_slug !== "geo", start, maxStarts: 1 });
    expect(out.started).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    const untouched = h.runs.filter((r) => r.id.startsWith("dry-") && r.cron_dedupe_key.startsWith("first-run-preview:"));
    expect(untouched.map((r) => r.agent_slug).sort()).toEqual(["geo", out.started[0] === "seo" ? "reddit_organic" : "seo"].sort());
  });

  it("skips a channel the plan still does not include", async () => {
    const started = await rerunPreviewsOnUpgrade(T, { planIncludes: async (_t, slug) => slug === "seo", start: ok() });
    expect(started).toEqual(["seo"]);
  });

  it("an unknown plan THROWS (retried), never reads as 'not included'", async () => {
    await expect(
      rerunPreviewsOnUpgrade(T, { planIncludes: async () => { throw new Error("db"); }, start: ok() }),
    ).rejects.toThrow();
  });

  it("a transient start failure restores the key and THROWS, so the worker retries", async () => {
    const start = vi.fn(async () => ({ started: false as const, permanent: false, reason: "budget_unavailable" }));
    await expect(rerunPreviewsOnUpgrade(T, { ...all, start })).rejects.toThrow(/did not start/);
    expect(h.runs.find((r) => r.id === "dry-seo")!.cron_dedupe_key).toBe(`first-run-preview:${T}:seo`);
    expect((await rerunPreviewsOnUpgrade(T, { ...all, start: ok() })).sort()).toEqual(["reddit_organic", "seo"]);
  });

  it("a permanent refusal restores the key and does NOT throw (no retry storm)", async () => {
    const start = vi.fn(async () => ({ started: false as const, permanent: true, reason: "coming_soon" }));
    expect(await rerunPreviewsOnUpgrade(T, { ...all, start })).toEqual([]);
    expect(h.runs.find((r) => r.id === "dry-seo")!.cron_dedupe_key).toBe(`first-run-preview:${T}:seo`);
  });

  it("reconciles a retired dry row whose real run never appeared", async () => {
    h.runs = [{ ...dry("seo"), cron_dedupe_key: `first-run-preview-done:${T}:seo` }];
    const start = ok();
    expect(await rerunPreviewsOnUpgrade(T, { ...all, start })).toEqual(["seo"]);
  });

  it("a preview that failed before it was marked dry is left alone", async () => {
    h.runs = [{ ...dry("seo", "dispatch_error"), preview_action_types: null }];
    const start = ok();
    expect(await rerunPreviewsOnUpgrade(T, { ...all, start })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("a succeeded real run is left alone", async () => {
    h.runs = [{ ...dry("seo"), preview_action_types: null }];
    const start = ok();
    expect(await rerunPreviewsOnUpgrade(T, { ...all, start })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call starts nothing", async () => {
    const start = ok();
    await rerunPreviewsOnUpgrade(T, { ...all, start });
    start.mockClear();
    expect(await rerunPreviewsOnUpgrade(T, { ...all, start })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("maybeSendUpgradeActionsReadyEmail", () => {
  const paid = { planIncludes: async () => true };
  const free = { planIncludes: async () => false };
  const real = (slug: string, status = "success"): Run => ({
    id: `real-${slug}`,
    agent_slug: slug,
    status,
    cron_dedupe_key: `first-run-preview:${T}:${slug}`,
    preview_action_types: null,
  });
  function upgraded() {
    h.runs = [{ ...dry("seo"), cron_dedupe_key: `first-run-preview-done:${T}:seo` }, real("seo")];
    h.open = [{ run_id: "real-seo" }, { run_id: "real-seo" }, { run_id: "other" }];
  }

  it("sends once every re-run finished, counting their open actions", async () => {
    upgraded();
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: true, total: 2 });
    expect(h.sent[0]).toMatchObject({
      total: 2,
      channelsUrl: "https://www.zaviagent.com/workspace?tab=channels&channel=seo",
    });
    expect(h.flags).toHaveLength(1);
  });

  it("waits while a re-run is still going", async () => {
    upgraded();
    h.runs[1]!.status = "running";
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "still_running" });
  });

  it("a fast upgrade (previews never ran dry) still gets the email", async () => {
    h.runs = [real("seo")];
    h.open = [{ run_id: "real-seo" }];
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: true, total: 1 });
  });

  it("mixed: a dry preview not yet handed to its real run holds the email", async () => {
    h.runs = [dry("seo"), real("reddit_organic")];
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "reruns_pending" });
  });

  it("a channel the plan excludes is not waited on", async () => {
    h.runs = [real("seo"), dry("reddit_organic", "running")];
    h.open = [{ run_id: "real-seo" }];
    expect(
      await maybeSendUpgradeActionsReadyEmail(T, { planIncludes: async (_t, slug) => slug === "seo" }),
    ).toEqual({ sent: true, total: 1 });
  });

  it("a Free preview that failed before it was marked dry is NOT an upgrade", async () => {
    h.runs = [real("seo", "failed")];
    expect(await maybeSendUpgradeActionsReadyEmail(T, free)).toEqual({ sent: false, reason: "not_upgraded" });
  });

  it("does nothing for a tenant that has not upgraded", async () => {
    h.runs = [dry("seo"), dry("reddit_organic")];
    expect(await maybeSendUpgradeActionsReadyEmail(T, free)).toEqual({ sent: false, reason: "not_upgraded" });
  });

  it("two re-runs finishing together: only the claim winner sends", async () => {
    upgraded();
    const [a, b] = await Promise.all([
      maybeSendUpgradeActionsReadyEmail(T, paid),
      maybeSendUpgradeActionsReadyEmail(T, paid),
    ]);
    expect([a, b]).toContainEqual({ sent: true, total: 2 });
    expect([a, b]).toContainEqual({ sent: false, reason: "already_claimed" });
    expect(h.sent).toHaveLength(1);
  });

  it("no owner address: the claim is given back (nothing was sent)", async () => {
    upgraded();
    h.sendImpl = async () => ({ sent: false });
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "no_owner_email" });
    expect(h.claimed).toBe(false);
  });

  it("a definite SendGrid rejection gives the claim back, so a later run can retry", async () => {
    upgraded();
    h.sendImpl = async () => {
      throw Object.assign(new Error("Bad Request"), { code: 400, response: { body: {} } });
    };
    await expect(maybeSendUpgradeActionsReadyEmail(T, paid)).rejects.toThrow("Bad Request");
    expect(h.claimed).toBe(false);
  });

  it("an uncertain failure (timeout) KEEPS the claim: never a second email", async () => {
    upgraded();
    h.sendImpl = async () => {
      throw new Error("ETIMEDOUT");
    };
    await expect(maybeSendUpgradeActionsReadyEmail(T, paid)).rejects.toThrow("ETIMEDOUT");
    expect(h.claimed).toBe(true);
    h.sendImpl = null;
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "already_claimed" });
    expect(h.sent).toHaveLength(0);
  });

  it("the digest claimed first: the actions-ready email sends nothing", async () => {
    upgraded();
    h.claimed = true;
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "already_claimed" });
    expect(h.sent).toHaveLength(0);
  });

  it("legacy: sent=true with no claim row counts as claimed", async () => {
    upgraded();
    h.legacySent = true;
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "already_claimed" });
    expect(h.sent).toHaveLength(0);
  });

  it("is sent once", async () => {
    upgraded();
    h.alreadySent = true;
    expect(await maybeSendUpgradeActionsReadyEmail(T, paid)).toEqual({ sent: false, reason: "already_sent" });
  });
});

describe("requestPreviewUpgrade (billing webhook)", () => {
  beforeEach(() => {
    sends.length = 0;
  });
  it("names one of the tenant's preview runs so the worker can derive the tenant", async () => {
    expect(await requestPreviewUpgrade(T)).toBe(true);
    expect(sends).toEqual([{ name: "growth.preview_upgrade.requested", data: { run_id: "dry-seo", tenant_id: T } }]);
  });
  it("sends nothing for a tenant with no preview runs", async () => {
    h.runs = [];
    expect(await requestPreviewUpgrade(T)).toBe(false);
    expect(sends).toEqual([]);
  });
});
