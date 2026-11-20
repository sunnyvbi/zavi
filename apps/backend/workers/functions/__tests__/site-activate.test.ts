import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/sites/store", () => ({ siteStore: vi.fn() }));

import {
  handleSiteActivate,
  requestSiteActivate,
  siteActivateFn,
  SITE_ACTIVATE_EVENT,
  type SiteActivateDeps,
} from "../site-activate";
import { siteReconcileFn } from "../site-reconcile";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHA = "a".repeat(40);
const DEPLOY = "d0mg1abcde-0123abcd";

function harness(over: Partial<SiteActivateDeps> = {}) {
  const order: string[] = [];
  const deps: SiteActivateDeps = {
    activate: vi.fn(async () => {
      order.push("activate");
      return { url: "https://x.zaviagent.com" };
    }),
    prune: vi.fn(async () => {
      order.push("prune");
      return { deleted: [] };
    }),
    reconcile: vi.fn(async () => {
      order.push("reconcile");
      return { outcome: "repaired" as const, site: null };
    }),
    run: async (name, fn) => {
      order.push(`step:${name}`);
      return fn();
    },
    ...over,
  };
  return { deps, order };
}

const data = { tenant_id: TENANT, site_id: SITE, deploy_id: DEPLOY, sha: SHA };

describe("site/activate", () => {
  it("serializes every KV pointer writer of a site: env-scoped key shared with site/reconcile, limit 1", () => {
    const o = (siteActivateFn as unknown as { opts: { concurrency: unknown; id: string } }).opts;
    expect(o.concurrency).toEqual([{ key: '"site-pointer:" + event.data.site_id', limit: 1, scope: "env" }]);
    const r = (siteReconcileFn as unknown as { opts: { concurrency: unknown } }).opts;
    expect(r.concurrency).toEqual(o.concurrency);
  });

  it("an activation that fails for good still runs one reconcile step, then fails the run", async () => {
    const h = harness({ activate: vi.fn(async () => { throw new Error("kv write failed (500)"); }) });
    await expect(handleSiteActivate(data, h.deps)).rejects.toThrow("kv write failed (500)");
    expect(h.order).toEqual(["step:activate", "step:reconcile", "reconcile"]);
    expect(h.deps.reconcile).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE, source: "activation" });
    expect(h.deps.prune).not.toHaveBeenCalled();
  });

  it("a reconcile that also fails never masks the activation error", async () => {
    const h = harness({
      activate: vi.fn(async () => { throw new Error("activate boom"); }),
      reconcile: vi.fn(async () => { throw new Error("reconcile boom"); }),
    });
    await expect(handleSiteActivate(data, h.deps)).rejects.toThrow("activate boom");
  });

  it("activates in its own step, then prunes in a separate step", async () => {
    const h = harness();
    const res = await handleSiteActivate(data, h.deps);
    expect(res).toEqual({ url: "https://x.zaviagent.com" });
    expect(h.order).toEqual(["step:activate", "activate", "step:prune", "prune"]);
    expect(h.deps.activate).toHaveBeenCalledWith({
      tenant_id: TENANT,
      site_id: SITE,
      staged: { deploy_id: DEPLOY, sha: SHA, preview_url: "" },
      conductor_run_id: null,
    });
  });

  it("hands the activation the run that asked for it, so a stopped or failed run never goes live", async () => {
    const RUN = "33333333-3333-4333-8333-333333333333";
    const h = harness();
    await handleSiteActivate({ ...data, conductor_run_id: RUN }, h.deps);
    expect((h.deps.activate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ conductor_run_id: RUN });
    const bad = harness();
    await handleSiteActivate({ ...data, conductor_run_id: "not-a-run'; drop table sites" }, bad.deps);
    expect((bad.deps.activate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ conductor_run_id: null });
  });

  it("ignores a hostname in the event: the publisher reads it from the site row", async () => {
    const h = harness();
    await handleSiteActivate({ ...data, hostname: "evil.example.com" }, h.deps);
    const arg = (h.deps.activate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(arg)).not.toContain("evil");
  });

  it("superseded: no prune", async () => {
    const h = harness({ activate: vi.fn(async () => ({ superseded: true as const })) });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ superseded: true });
    expect(h.deps.prune).not.toHaveBeenCalled();
  });

  it("a prune failure never changes the activation result", async () => {
    const h = harness({ prune: vi.fn(async () => { throw new Error("r2 down"); }) });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ url: "https://x.zaviagent.com" });
  });

  it("bad payloads are skipped without activating", async () => {
    for (const bad of [
      {},
      { ...data, sha: "nope" },
      { ...data, deploy_id: "../x" },
      { ...data, tenant_id: "" },
      { ...data, site_id: 5 },
    ]) {
      const h = harness();
      expect(await handleSiteActivate(bad, h.deps)).toEqual({ skipped: "bad_request" });
      expect(h.deps.activate).not.toHaveBeenCalled();
    }
  });

  it("requestSiteActivate sends one deduped event per (site, deploy) without a hostname", async () => {
    const send = vi.fn(async () => undefined);
    await requestSiteActivate({ ...data, preview_url: "https://x/__zavi_preview/d/?t=secret" }, send);
    expect(send).toHaveBeenCalledWith({
      id: `site-activate:${SITE}:${DEPLOY}`,
      name: SITE_ACTIVATE_EVENT,
      data: { tenant_id: TENANT, site_id: SITE, deploy_id: DEPLOY, sha: SHA },
    });
  });

  it("carries the publish generation to the CAS; a malformed one is refused, never dropped", async () => {
    const send = vi.fn(async () => undefined);
    await requestSiteActivate({ ...data, generation: 7 }, send);
    expect((send.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ generation: 7 });
    await requestSiteActivate({ ...data, generation: -1 }, send);
    expect((send.mock.calls[1] as unknown as [{ data: Record<string, unknown> }])[0].data).not.toHaveProperty("generation");

    const h = harness();
    await handleSiteActivate({ ...data, generation: 7 }, h.deps);
    expect(h.deps.activate).toHaveBeenCalledWith(expect.objectContaining({ generation: 7 }));
    const bad = harness();
    expect(await handleSiteActivate({ ...data, generation: "7" }, bad.deps)).toEqual({ skipped: "bad_request" });
    expect(bad.deps.activate).not.toHaveBeenCalled();
  });

  it("records the company website in its own step after prune, with the activated url", async () => {
    const recordCompanyWebsite = vi.fn(async () => "recorded");
    const h = harness({ recordCompanyWebsite });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(h.order).toEqual(["step:activate", "activate", "step:prune", "prune", "step:company-website"]);
    expect(recordCompanyWebsite).toHaveBeenCalledTimes(1);
    expect(recordCompanyWebsite).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE, url: "https://x.zaviagent.com" });
  });

  it("a superseded activation never records a company website", async () => {
    const recordCompanyWebsite = vi.fn(async () => "recorded");
    const h = harness({ recordCompanyWebsite, activate: vi.fn(async () => ({ superseded: true as const })) });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ superseded: true });
    expect(recordCompanyWebsite).not.toHaveBeenCalled();
  });

  it("a failed activation never records a company website", async () => {
    const recordCompanyWebsite = vi.fn(async () => "recorded");
    const h = harness({ recordCompanyWebsite, activate: vi.fn(async () => { throw new Error("kv down"); }) });
    await expect(handleSiteActivate(data, h.deps)).rejects.toThrow("kv down");
    expect(recordCompanyWebsite).not.toHaveBeenCalled();
  });

  it("a company-website failure never changes or retries the activation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recordCompanyWebsite = vi.fn(async () => { throw new Error("set_tenant_company_domain_system failed: boom"); });
    const h = harness({ recordCompanyWebsite });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(h.deps.activate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("company website not recorded");
    warn.mockRestore();
  });
  it("expires the SEO crawl of the published site in its own step, last", async () => {
    const expireSeoAudit = vi.fn(async () => ({ expired: true }));
    const h = harness({ expireSeoAudit });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ url: "https://x.zaviagent.com" });
    expect(h.order.at(-1)).toBe("step:seo-snapshot-expire");
    expect(expireSeoAudit).toHaveBeenCalledWith(TENANT, "https://x.zaviagent.com");
  });

  it("a superseded activation leaves the SEO crawl alone, and an expiry failure never fails the activation", async () => {
    const expireSeoAudit = vi.fn(async () => { throw new Error("db down"); });
    const superseded = harness({ expireSeoAudit, activate: vi.fn(async () => ({ superseded: true as const })) });
    await handleSiteActivate(data, superseded.deps);
    expect(expireSeoAudit).not.toHaveBeenCalled();
    const h = harness({ expireSeoAudit });
    expect(await handleSiteActivate(data, h.deps)).toEqual({ url: "https://x.zaviagent.com" });
  });
});
