
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  send: vi.fn(async (_a: {
    siteName: string;
    liveUrl: string;
    ownerLogin?: { email: string; mint: () => Promise<string> } | null;
  }) => ({ sent: true })),
}));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => fakeSb(h.tables),
  asTenantId: (t: string) => t,
}));
const adminMail = vi.hoisted(() => ({
  send: vi.fn(async (_a: { siteName: string; adminUrl: string; ownerLogin: { email: string; mint: () => Promise<string> } }) => ({ sent: true })),
}));
vi.mock("@/email/sendAuthEmail", () => ({ sendBuildLiveEmail: h.send, sendSiteAdminLoginEmail: adminMail.send }));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));
const flags = vi.hoisted(() => ({ ownerOn: true, away: false }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) =>
    (key === "build_auto_site_owner" && flags.ownerOn) || (key === "build_live_email_only_if_away" && flags.away),
  ),
}));

import { deployCompleted, maybeSendBuildLiveEmail } from "../build-live-email";
import { renderBuildLiveEmail } from "@/email/templates/build-live";
import { renderSiteAdminLoginEmail } from "@/email/templates/site-admin-login";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const deploy = (site_id: string) => ({
  id: "d",
  status: "done",
  hosting_verified_at: "2026-09-30T01:00:00Z",
  payload: { stage: "deploy", site_id },
});

function seed() {
  h.tables = {
    conductor_runs: [
      { id: "run-a", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x", goal_graph: [{ payload: { stage: "provision" } }, deploy(A)] },
      { id: "run-b", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Beta — y", goal_graph: [deploy(B)] },
      { id: "ref-a", tenant_id: T1, kind: "build_app", status: "done", objective: "[refine] tweak", goal_graph: [{ payload: { stage: "build", refine_mode: true, site_id: A } }, deploy(A)] },
      { id: "run-c", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Gamma — z", goal_graph: [deploy("cccccccc-0000-4000-8000-000000000003")] },
    ],
    tenant_resources: [{ tenant_id: T1, resource_kind: "hosting", status: "ready", external_ref: { url: "https://old.onrender.com" } }],
    tenants: [{ id: T1, display_name: "Acme" }],
  };
}

function stores() {
  return fakeSiteStore([
    siteRow({ id: A, label: "alpha", root_conductor_run_id: "run-a", status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    siteRow({ id: B, label: "beta", root_conductor_run_id: "run-b", status: "live", live_deploy_id: "d2", live_url: "https://beta.zaviagent.com", owner_email: null }),
  ]).store;
}

describe("maybeSendBuildLiveEmail for new-flow sites", () => {
  beforeEach(() => {
    h.send.mockClear();
    flags.ownerOn = true;
    seed();
  });

  it("with build_auto_site_owner off the site is still mailed, with no sign-in line and nothing minted", async () => {
    flags.ownerOn = false;
    const ownerMagicLink = vi.fn(async () => "https://ref.supabase.co/verify?token=x");
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].ownerLogin).toBeUndefined();
    expect(ownerMagicLink).not.toHaveBeenCalled();
  });

  it("an old-flow run is mailed from tenant_resources and never reads the (throwing) site store", async () => {
    flags.ownerOn = false;
    h.tables.conductor_runs.push({ id: "run-old", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Old — z", goal_graph: [{ id: "d", status: "done", hosting_verified_at: "2026-09-30T01:00:00Z", payload: { stage: "deploy" } }] });
    const throwing = new Proxy({}, { get: () => () => { throw new Error("sites table unreachable"); } }) as never;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-old" }, { store: throwing })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].liveUrl).toBe("https://old.onrender.com");
  });

  it("mails the site's own URL and a fresh link minted at send time", async () => {
    let n = 0;
    const ownerMagicLink = vi.fn(async () => `https://ref.supabase.co/verify?token=email-link-${++n}`);
    const r = await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink });
    expect(r).toEqual({ sent: true });
    const arg = h.send.mock.calls[0][0];
    expect(arg).toMatchObject({ siteName: "Alpha", liveUrl: "https://alpha.zaviagent.com" });
    expect(arg.ownerLogin?.email).toBe("owner@example.test");
    expect(ownerMagicLink).not.toHaveBeenCalled();
    expect(await arg.ownerLogin!.mint()).toBe("https://ref.supabase.co/verify?token=email-link-1");
    expect(await arg.ownerLogin!.mint()).toBe("https://ref.supabase.co/verify?token=email-link-2");
    expect((ownerMagicLink.mock.calls as unknown[][])[0][0]).toMatchObject({ site_id: A, redirect_to: "https://alpha.zaviagent.com/admin" });
  });

  describe("the owner's admin login (QA 2026-10-02: it used to be a password-reset mail)", () => {
    const once = () => {
      const used = new Set<string>();
      return {
        claimAdminLogin: vi.fn(async (_t: string, site: string) => (used.has(site) ? false : (used.add(site), true))),
        releaseAdminLogin: vi.fn(async (_t: string, site: string) => void used.delete(site)),
      };
    };
    beforeEach(() => {
      adminMail.send.mockClear();
      flags.away = false;
    });

    it("the live email carries the link: no second email, and the once-claim is taken", async () => {
      h.send.mockResolvedValueOnce({ sent: true, owner_login: true } as never);
      const c = once();
      const ownerMagicLink = vi.fn(async () => "https://alpha.zaviagent.com/auth/confirm?t=1");
      expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, ...c })).toEqual({ sent: true });
      expect(h.send.mock.calls[0][0]).toMatchObject({ ownerAdminUrl: "https://alpha.zaviagent.com/admin" });
      expect(adminMail.send).not.toHaveBeenCalled();
      expect(c.claimAdminLogin).toHaveBeenCalledWith(T1, A);
    });

    it("the live email went out without a link: the admin login email follows, once per site", async () => {
      const c = once();
      const ownerMagicLink = vi.fn(async () => "https://alpha.zaviagent.com/auth/confirm?t=2");
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, ...c });
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, ...c });
      expect(adminMail.send).toHaveBeenCalledTimes(1);
      const arg = adminMail.send.mock.calls[0][0];
      expect(arg).toMatchObject({ siteName: "Alpha", adminUrl: "https://alpha.zaviagent.com/admin", ownerLogin: { email: "owner@example.test" } });
      expect(await arg.ownerLogin.mint()).toBe("https://alpha.zaviagent.com/auth/confirm?t=2");
    });

    it("the founder was watching (no live email): the admin login email still goes out, once", async () => {
      flags.away = true;
      const c = once();
      const watching = vi.fn(async () => true);
      const ownerMagicLink = vi.fn(async () => "https://alpha.zaviagent.com/auth/confirm?t=3");
      expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, watching, ...c })).toEqual({ sent: false, reason: "watching" });
      expect(h.send).not.toHaveBeenCalled();
      expect(adminMail.send).toHaveBeenCalledTimes(1);
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, watching, ...c });
      expect(adminMail.send).toHaveBeenCalledTimes(1);
    });

    it("a failed admin login send releases the claim so a later publish retries; no owner = nothing", async () => {
      const c = once();
      adminMail.send.mockRejectedValueOnce(new Error("mint failed"));
      const ownerMagicLink = vi.fn(async () => "x");
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, ...c });
      expect(c.releaseAdminLogin).toHaveBeenCalledWith(T1, A);
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store: stores(), ownerMagicLink, ...c });
      expect(adminMail.send).toHaveBeenCalledTimes(2);
      adminMail.send.mockClear();
      await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-b" }, { store: stores(), ownerMagicLink, ...c });
      expect(adminMail.send).not.toHaveBeenCalled();
    });
  });

  it("two sites in one tenant each mail their own URL", async () => {
    const store = stores();
    await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store });
    await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-b" }, { store });
    expect(h.send.mock.calls.map((c) => c[0].liveUrl)).toEqual(["https://alpha.zaviagent.com", "https://beta.zaviagent.com"]);
    expect(h.send.mock.calls[1][0].ownerLogin).toBeUndefined();
  });

  it("a site refine is named after the site's root build", async () => {
    await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "ref-a" }, { store: stores() });
    expect(h.send.mock.calls[0][0].siteName).toBe("Alpha");
  });

  it("names the site after itself, never the workspace in the objective nor the hashes (QA B24)", async () => {
    h.tables.conductor_runs[0].objective = "Build product: Apna Tutor — Build a website for Mile High Coffee";
    const store = fakeSiteStore([
      siteRow({ id: A, label: "mile-high-coffee-693dfbdb-523441", root_conductor_run_id: "run-a", status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    ]).store;
    await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store });
    expect(h.send.mock.calls[0][0].siteName).toBe("Mile High Coffee");
  });

  it("a site that was never activated is not mailed", async () => {
    const store = fakeSiteStore([siteRow({ id: A, root_conductor_run_id: "run-a", status: "publishing" })]).store;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store })).toEqual({ sent: false, reason: "no_live_url" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a site id not in this tenant is not mailed (never the singleton URL)", async () => {
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-c" }, { store: stores() })).toEqual({ sent: false, reason: "no_site" });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("maybeSendBuildLiveEmail: a run that never published (build_publish_on_request)", () => {
  const previewBuild = [
    { id: "p", status: "done", payload: { stage: "provision", site_id: A } },
    { id: "b", status: "done", child_run_id: "child-build", payload: { stage: "build", fast_single_pass: true, site_id: A } },
  ];
  const previewEdit = [{ id: "e", status: "done", child_run_id: "child-edit", payload: { stage: "build", refine_mode: true, site_id: A } }];

  beforeEach(() => {
    h.send.mockClear();
    flags.ownerOn = true;
    seed();
    h.tables.conductor_runs.push(
      { id: "run-preview", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x", goal_graph: previewBuild },
      { id: "edit-preview", tenant_id: T1, kind: "build_app", status: "done", objective: "[refine] tweak", goal_graph: previewEdit },
    );
  });

  it.each(["run-preview", "edit-preview"])("%s: a done run with no deploy node sends nothing, mints nothing and never reads the site, even when the site is live with an owner", async (runId) => {
    const store = stores();
    const get = vi.spyOn(store, "get");
    const ownerMagicLink = vi.fn(async () => "https://ref.supabase.co/verify?token=x");
    const claimSiteEmail = vi.fn(async () => true);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: runId }, { store, ownerMagicLink, claimSiteEmail })).toEqual({
      sent: false,
      reason: "not_deployed",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(ownerMagicLink).not.toHaveBeenCalled();
    expect(claimSiteEmail).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("the same build with a completed deploy node is mailed (the fixture sends once it is published)", async () => {
    const run = h.tables.conductor_runs.find((r) => r.id === "run-preview")!;
    run.goal_graph = [...previewBuild, deploy(A)];
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-preview" }, { store: stores() })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].liveUrl).toBe("https://alpha.zaviagent.com");
  });

  it("deployCompleted: no deploy node is never a completed deploy, and a pending or unverified one is not either", () => {
    expect(deployCompleted(previewBuild)).toBe(false);
    expect(deployCompleted(previewEdit)).toBe(false);
    expect(deployCompleted([])).toBe(false);
    expect(deployCompleted([...previewBuild, { id: "d", status: "pending", payload: { stage: "deploy", site_id: A } }])).toBe(false);
    expect(deployCompleted([...previewBuild, { id: "d", status: "done", payload: { stage: "deploy", site_id: A } }])).toBe(false);
    expect(deployCompleted([...previewBuild, deploy(A)])).toBe(true);
  });
});

describe("renderBuildLiveEmail owner sign-in line", () => {
  it("adds the line only when a link is given", () => {
    const base = { siteName: "Alpha", liveUrl: "https://alpha.zaviagent.com", workspaceUrl: "https://www.zaviagent.com/workspace" };
    expect(renderBuildLiveEmail(base).text).not.toContain("Log in to your admin");
    const r = renderBuildLiveEmail({ ...base, ownerLoginUrl: "https://ref.supabase.co/verify?token=t&x=<y>" });
    expect(r.text).toContain("Log in to your admin with this one-time link (no password; it expires soon): https://ref.supabase.co/verify?token=t&x=<y>");
    expect(r.html).toContain("https://ref.supabase.co/verify?token=t&amp;x=&lt;y&gt;");
  });

  it('"Your admin login for <site>": plain words, the one-time link, the admin page, never reset-password wording', () => {
    const r = renderSiteAdminLoginEmail({
      siteName: "Sudsy <Paws>",
      adminUrl: "https://sudsy.zaviagent.com/admin",
      loginUrl: "https://sudsy.zaviagent.com/auth/confirm?type=magiclink&t=a&b=<c>",
      workspaceUrl: "https://www.zaviagent.com/workspace",
    });
    expect(r.subject).toBe("Your admin login for Sudsy <Paws>");
    expect(r.text).toContain("Log in to your admin (works once, no password, expires soon): https://sudsy.zaviagent.com/auth/confirm?type=magiclink&t=a&b=<c>");
    expect(r.text).toContain("Your admin page is always at https://sudsy.zaviagent.com/admin?from=zavi. ");
    expect(r.html).toContain('<a href="https://sudsy.zaviagent.com/admin?from=zavi">https://sudsy.zaviagent.com/admin?from=zavi</a>');
    expect(r.html).toContain("Sudsy &lt;Paws&gt;");
    expect(r.html).not.toContain("Sudsy <Paws>");
    expect(r.html).toContain("t=a&amp;b=&lt;c&gt;");
    for (const s of [r.subject, r.text, r.html]) {
      expect(s).not.toMatch(/reset your password|ignore this email|did not ask/i);
      expect(s).not.toContain("—");
    }
  });

  it("names the admin page for an owner, with or without a login link (QA 2026-10-02)", () => {
    const base = { siteName: "Alpha", liveUrl: "https://alpha.zaviagent.com", workspaceUrl: "https://www.zaviagent.com/workspace" };
    const withLink = renderBuildLiveEmail({ ...base, ownerAdminUrl: "https://alpha.zaviagent.com/admin", ownerLoginUrl: "https://alpha.zaviagent.com/auth/confirm?t=1" });
    expect(withLink.text).toContain("Your admin page: https://alpha.zaviagent.com/admin?from=zavi\n");
    expect(withLink.text).toContain("expires soon): https://alpha.zaviagent.com/auth/confirm?t=1\n");
    expect(withLink.text).toContain("one-time link");
    expect(withLink.html).toContain('href="https://alpha.zaviagent.com/admin?from=zavi">https://alpha.zaviagent.com/admin?from=zavi</a>');
    expect(withLink.html).toContain('href="https://alpha.zaviagent.com/auth/confirm?t=1"');
    const noLink = renderBuildLiveEmail({ ...base, ownerAdminUrl: "https://alpha.zaviagent.com/admin" });
    expect(noLink.text).toContain("Your admin page: https://alpha.zaviagent.com/admin?from=zavi\n");
    expect(noLink.text).toContain('press "Email me a new login link"');
    for (const s of [withLink.text, noLink.text]) expect(s).not.toMatch(/reset your password|ignore this email/i);
  });
});
