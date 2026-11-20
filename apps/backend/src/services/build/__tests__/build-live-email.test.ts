import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  send: vi.fn(async (_a: Record<string, unknown>) => ({ sent: true })),
  order: [] as string[],
  keyOn: false,
  announceOn: false,
  signup: true as boolean | null,
  ownerEmail: "owner@zavi.co" as string | null,
  site: [] as Array<{ id: string; email: string | null; revoked: boolean }>,
  create: vi.fn(async (_t: string, _email: string) => ({
    token: "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    invite: { id: "42", role: "admin", created_at: "2026-09-30T00:00:00.000Z", expires_at: "2026-10-07T00:00:00.000Z" },
  })),
  activate: vi.fn(async (_t: string, _id: string) => ({})),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(
    async (key: string) =>
      (key === "build_auto_site_owner" && h.keyOn) || (key === "build_live_announcement" && h.announceOn),
  ),
}));
vi.mock("@/services/website/site-signup", () => ({ siteHasSignupPage: vi.fn(async () => h.signup) }));
vi.mock("@/services/website/app-invites", () => ({
  createOwnerAdminInvite: async (...a: [string, string]) => {
    h.order.push("create");
    const out = await h.create(...a);
    h.site.push({ id: out.invite.id, email: a[1], revoked: true });
    return out;
  },
  activateAppInvite: async (...a: [string, string]) => {
    h.order.push("activate");
    const out = await h.activate(...a);
    for (const i of h.site) if (i.id === a[1]) i.revoked = false;
    return out;
  },
  hasOwnerAdminInvite: async (_t: string, email: string) =>
    h.site.some((i) => i.email === email.toLowerCase() && !i.revoked),
}));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => fakeSb(h.tables),
  asTenantId: (t: string) => t,
}));
vi.mock("@/email/sendAuthEmail", () => ({
  resolveTenantOwnerEmail: async () => h.ownerEmail,
  sendBuildLiveEmail: (a: Record<string, unknown>) => {
    h.order.push("send");
    return h.send(a);
  },
}));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));

import {
  siteNameFromObjective,
  liveUrlFromResources,
  maybeSendBuildLiveEmail,
  ownerAdminAccess,
  clearOwnerAdminAccessCache,
  OWNER_ADMIN_ACCESS_TTL_MS,
  OWNER_INVITE_ACTIVATION_ATTEMPTS,
} from "../build-live-email";
import { renderBuildLiveEmail } from "@/email/templates/build-live";

const T = "t1";
const engineerNode = (extra: Record<string, unknown> = {}) => ({
  id: "n-eng",
  status: "done",
  target_agent_slug: "engineer",
  payload: { stage: "build", ...extra },
});
const deployNode = (status = "done", verified = status === "done") => ({
  id: "n-dep",
  status,
  target_agent_slug: "",
  payload: { stage: "deploy" },
  ...(verified ? { hosting_verified_at: "2026-09-27T01:00:00.000Z" } : {}),
});

function seed(runs: Array<Record<string, unknown>>) {
  h.tables = {
    conductor_runs: runs.map((r) => ({ tenant_id: T, kind: "build_app", status: "done", ...r })),
    tenant_resources: [
      { tenant_id: T, resource_kind: "hosting", status: "ready", external_ref: { url: "https://bloodlink-feef248f.onrender.com" } },
    ],
    tenants: [{ id: T, display_name: "Acme" }],
  };
}

describe("maybeSendBuildLiveEmail: only a completed deploy is 'live' (codex review of #3272)", () => {
  beforeEach(() => {
    h.send.mockClear();
  });

  it("a PR-only refine (direct-merge brake on, no deploy node) sends no mail", async () => {
    seed([{ id: "cr-ref", objective: "[refine] Add SSO", goal_graph: [engineerNode({ refine_mode: true })] }]);
    const r = await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" });
    expect(r).toEqual({ sent: false, reason: "not_deployed" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a build whose deploy node did not complete sends no mail", async () => {
    seed([{ id: "cr-1", objective: "Build product: BloodLink — x", goal_graph: [engineerNode(), deployNode("failed")] }]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toMatchObject({ sent: false });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a deploy node passed through done with no hosting check sends no mail", async () => {
    seed([{ id: "cr-1", objective: "Build product: BloodLink — x", goal_graph: [engineerNode(), deployNode("done", false)] }]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({
      sent: false,
      reason: "not_deployed",
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a deployed refine finds the original build's name behind any number of newer refines", async () => {
    const refines = Array.from({ length: 25 }, (_, i) => ({
      id: `cr-ref-${i}`,
      objective: `[refine] change ${i}`,
      created_at: `2026-09-27T02:${String(i).padStart(2, "0")}:00Z`,
      goal_graph: [engineerNode({ refine_mode: true }), deployNode()],
    }));
    seed([
      ...refines,
      { id: "cr-1", objective: "Build product: BloodLink — x", created_at: "2026-09-27T01:00:00Z", goal_graph: [engineerNode(), deployNode()] },
    ]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref-24" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].siteName).toBe("BloodLink");
  });

  it("a deployed build mails with the site name", async () => {
    seed([{ id: "cr-1", objective: "Build product: BloodLink — Blood donation platform", goal_graph: [engineerNode(), deployNode()] }]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0]).toMatchObject({ siteName: "BloodLink", liveUrl: "https://bloodlink-feef248f.onrender.com" });
  });

  describe("DEL-1323 B20: the email links the same address the live card announces", () => {
    const withDomain = (status: string) => {
      seed([{ id: "cr-1", objective: "Build product: BloodLink — x", goal_graph: [engineerNode(), deployNode()] }]);
      h.tables.tenant_resources!.push({
        tenant_id: T,
        resource_kind: "domain",
        status: "pending",
        external_ref: { hostname: "bloodlink.zaviagent.com", status },
      });
    };
    afterEach(() => {
      h.announceOn = false;
    });

    it("a live branded address is mailed instead of the Render host", async () => {
      h.announceOn = true;
      withDomain("live");
      expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
      expect(h.send.mock.calls[0][0].liveUrl).toBe("https://bloodlink.zaviagent.com");
    });

    it("a branded address still being set up is not mailed", async () => {
      h.announceOn = true;
      withDomain("provisioning");
      await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" });
      expect(h.send.mock.calls[0][0].liveUrl).toBe("https://bloodlink-feef248f.onrender.com");
    });

    it("with build_live_announcement off the email keeps the Render host", async () => {
      withDomain("live");
      await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" });
      expect(h.send.mock.calls[0][0].liveUrl).toBe("https://bloodlink-feef248f.onrender.com");
    });
  });

  it("a deployed refine is named after the site, never '[refine] …'", async () => {
    seed([
      { id: "cr-ref", objective: "[refine] Add SSO", created_at: "2026-09-27T02:00:00Z", goal_graph: [engineerNode({ refine_mode: true }), deployNode()] },
      { id: "cr-1", objective: "Build product: BloodLink — Blood donation platform", created_at: "2026-09-27T01:00:00Z", goal_graph: [engineerNode(), deployNode()] },
    ]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].siteName).toBe("BloodLink");
  });

  it("a newer new-flow site never renames the old app in its refine email (review F3)", async () => {
    const SITE = "e0000000-0000-4000-8000-000000000001";
    seed([
      { id: "cr-ref", objective: "[refine] Add SSO", created_at: "2026-09-27T03:00:00Z", goal_graph: [engineerNode({ refine_mode: true }), deployNode()] },
      {
        id: "cr-site",
        objective: "Build product: Beta — new site",
        created_at: "2026-09-27T02:00:00Z",
        goal_graph: [{ id: "p", status: "done", payload: { stage: "provision", site_id: SITE } }, engineerNode({ site_id: SITE }), deployNode()],
      },
      { id: "cr-1", objective: "Build product: Alpha — the old app", created_at: "2026-09-27T01:00:00Z", goal_graph: [engineerNode(), deployNode()] },
    ]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].siteName).toBe("Alpha");
  });

  it("a newer refused old-flow build that failed never renames the live app in its refine email", async () => {
    seed([
      { id: "cr-ref", objective: "[refine] Add SSO", created_at: "2026-09-27T03:00:00Z", goal_graph: [engineerNode({ refine_mode: true }), deployNode()] },
      { id: "cr-refused", status: "failed", objective: "Build product: Dog Spa — refused", created_at: "2026-09-27T02:00:00Z", goal_graph: [] },
      { id: "cr-1", objective: "Build product: Cake Co — the live app", created_at: "2026-09-27T01:00:00Z", goal_graph: [engineerNode(), deployNode()] },
    ]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].siteName).toBe("Cake Co");
  });

  it("a deployed refine with no original build on record falls back to the company name", async () => {
    seed([{ id: "cr-ref", objective: "[refine] Add SSO", goal_graph: [engineerNode({ refine_mode: true }), deployNode()] }]);
    await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" });
    expect(h.send.mock.calls[0][0].siteName).toBe("Acme");
  });
});

describe("DEL-1323 B3: the live email gives the owner a way into /admin", () => {
  const LIVE = "https://bloodlink-feef248f.onrender.com";
  const build = () =>
    seed([{ id: "cr-1", objective: "Build product: BloodLink — Blood donation platform", goal_graph: [engineerNode(), deployNode()] }]);

  beforeEach(() => {
    h.send.mockReset();
    h.send.mockImplementation(async () => ({ sent: true }));
    h.create.mockClear();
    h.activate.mockReset();
    h.activate.mockImplementation(async () => ({}));
    h.order = [];
    h.keyOn = true;
    h.signup = true;
    h.ownerEmail = "owner@zavi.co";
    h.site = [];
    clearOwnerAdminAccessCache();
  });

  it("mints an admin invite that is revoked until the email is sent, and mails the one-click magic login link and /admin", async () => {
    build();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.create).toHaveBeenCalledWith(T, "owner@zavi.co");
    expect(h.send.mock.calls[0][0].admin).toEqual({
      adminUrl: `${LIVE}/admin`,
      setupUrl: `${LIVE}/api/auth/magic?token=tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`,
    });
    expect(JSON.stringify(h.send.mock.calls[0][0])).not.toContain("/signup");
    expect(h.activate).toHaveBeenCalledWith(T, "42");
    expect(h.order).toEqual(["create", "send", "activate"]);
  });

  it("retries a transient activation failure after the send so the emailed setup link works", async () => {
    build();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let active = false;
    h.activate.mockImplementation(async () => {
      if (h.activate.mock.calls.length <= 2) throw new Error("connection terminated unexpectedly");
      active = true;
      return {};
    });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.activate).toHaveBeenCalledTimes(OWNER_INVITE_ACTIVATION_ATTEMPTS);
    expect(h.activate.mock.calls.every(([t, id]) => t === T && id === "42")).toBe(true);
    expect(h.order).toEqual(["create", "send", "activate", "activate", "activate"]);
    expect(active).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops after the attempt cap and never resends the email when activation keeps failing", async () => {
    build();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.activate.mockImplementation(async () => {
      throw Object.assign(new Error("down"), { code: "app_db_not_ready" });
    });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({
      sent: true,
      reason: "owner_link_inactive",
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.activate).toHaveBeenCalledTimes(OWNER_INVITE_ACTIVATION_ATTEMPTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("app_db_not_ready"));
    warn.mockRestore();
  });

  it("does not retry an invite that can no longer be activated", async () => {
    build();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.activate.mockImplementation(async () => {
      throw Object.assign(new Error("Invite not found."), { code: "app_invite_not_found" });
    });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({
      sent: true,
      reason: "owner_link_inactive",
    });
    expect(h.activate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("app_invite_not_found"));
    warn.mockRestore();
  });

  it("never mints an invite when the owner has no email to bind it to", async () => {
    build();
    h.ownerEmail = null;
    h.send.mockImplementation(async () => ({ sent: false }));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({
      sent: false,
      reason: "no_owner_email",
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("never activates the invite when the send reports no recipient", async () => {
    build();
    h.send.mockImplementation(async () => ({ sent: false }));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({
      sent: false,
      reason: "no_owner_email",
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.activate).not.toHaveBeenCalled();
    expect(await ownerAdminAccess(T, LIVE)).toBeNull();
  });

  describe("the ready card's admin line agrees with the email", () => {
    const cases: Array<[string, () => void, boolean]> = [
      ["invite emailed and activated", () => undefined, true],
      ["no owner email", () => (h.ownerEmail = null), false],
      ["no sign-up page", () => (h.signup = false), false],
      ["key off", () => (h.keyOn = false), false],
      [
        "roles schema missing",
        () =>
          h.create.mockImplementationOnce(async () => {
            throw Object.assign(new Error("Roles aren't set up on this site yet."), { code: "roles_not_configured" });
          }),
        false,
      ],
      [
        "send failed",
        () =>
          h.send.mockImplementation(async () => {
            throw new Error("sendgrid down");
          }),
        false,
      ],
    ];
    for (const [name, arrange, eligible] of cases) {
      it(`${name}: card ${eligible ? "shows" : "hides"} the admin line exactly when the email carried it`, async () => {
        build();
        arrange();
        await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" });
        const mailedAdmin = h.send.mock.calls.length > 0 && "admin" in h.send.mock.calls[0][0] && h.activate.mock.calls.length > 0;
        const card = await ownerAdminAccess(T, LIVE);
        expect(mailedAdmin).toBe(eligible);
        expect(card !== null).toBe(eligible);
        if (card) expect(card).toEqual({ adminUrl: `${LIVE}/admin`, ownerEmail: "owner@zavi.co" });
      });
    }

    it("an invite bound to a different email never lights the card", async () => {
      h.site = [{ id: "7", email: "someone@else.co", revoked: false }];
      expect(await ownerAdminAccess(T, LIVE)).toBeNull();
    });
  });

  describe("the ready card's admin lookup is cached per tenant and site", () => {
    let calls = 0;
    beforeEach(async () => {
      calls = 0;
      const invites = await import("@/services/website/app-invites");
      vi.spyOn(invites, "hasOwnerAdminInvite").mockImplementation(async (_t, email) => {
        calls += 1;
        return h.site.some((i) => i.email === email.toLowerCase() && !i.revoked);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("build-status polls inside the TTL open one site-DB read, not one per poll", async () => {
      h.site = [{ id: "42", email: "owner@zavi.co", revoked: false }];
      for (let i = 0; i < 5; i++) expect(await ownerAdminAccess(T, LIVE)).not.toBeNull();
      expect(calls).toBe(1);
      await ownerAdminAccess("t2", LIVE);
      await ownerAdminAccess(T, `${LIVE}/other`);
      expect(calls).toBe(3);
    });

    it("re-reads once the TTL passes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      h.site = [{ id: "42", email: "owner@zavi.co", revoked: false }];
      expect(await ownerAdminAccess(T, LIVE)).not.toBeNull();
      h.site = [];
      vi.advanceTimersByTime(OWNER_ADMIN_ACCESS_TTL_MS - 1);
      expect(await ownerAdminAccess(T, LIVE)).not.toBeNull();
      vi.advanceTimersByTime(2);
      expect(await ownerAdminAccess(T, LIVE)).toBeNull();
      expect(calls).toBe(2);
    });

    it("a card polled before the email went out lights up right after activation, not a TTL later", async () => {
      build();
      h.send.mockImplementation(async () => {
        expect(await ownerAdminAccess(T, LIVE)).toBeNull();
        return { sent: true };
      });
      await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" });
      expect(h.activate).toHaveBeenCalledTimes(1);
      expect(await ownerAdminAccess(T, LIVE)).toEqual({ adminUrl: `${LIVE}/admin`, ownerEmail: "owner@zavi.co" });
      expect(calls).toBe(2);
    });

    it("a failed activation keeps the cached answer", async () => {
      build();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      h.activate.mockImplementation(async () => {
        throw Object.assign(new Error("gone"), { code: "app_invite_not_found" });
      });
      expect(await ownerAdminAccess(T, LIVE)).toBeNull();
      await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" });
      expect(await ownerAdminAccess(T, LIVE)).toBeNull();
      expect(calls).toBe(1);
      warn.mockRestore();
    });
  });

  it("never activates the invite when the send throws", async () => {
    build();
    h.send.mockImplementation(async () => {
      throw new Error("sendgrid down");
    });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: false, reason: "error" });
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("a site with no sign-up page gets the plain live email and no invite", async () => {
    build();
    h.signup = false;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0][0]).not.toHaveProperty("admin");
  });

  it("a site without the roles schema still gets its live email", async () => {
    build();
    h.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Roles aren't set up on this site yet."), { code: "roles_not_configured" });
    });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0]).not.toHaveProperty("admin");
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("a refine never mints another admin invite", async () => {
    seed([
      { id: "cr-ref", objective: "[refine] Add SSO", created_at: "2026-09-27T02:00:00Z", goal_graph: [engineerNode({ refine_mode: true }), deployNode()] },
      { id: "cr-1", objective: "Build product: BloodLink — x", created_at: "2026-09-27T01:00:00Z", goal_graph: [engineerNode(), deployNode()] },
    ]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-ref" })).toEqual({ sent: true });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("with build_auto_site_owner off the email is exactly the old one and no invite is written", async () => {
    build();
    h.keyOn = false;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T, conductor_run_id: "cr-1" })).toEqual({ sent: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0][0]).toEqual({
      tenant_id: T,
      siteName: "BloodLink",
      liveUrl: LIVE,
      workspaceUrl: "https://www.zaviagent.com/workspace",
    });
  });

  it("renders the admin page and the one-click 'Log in to your admin' link, escaped, with no sign-up step", () => {
    const base = { siteName: "BloodLink", liveUrl: LIVE, workspaceUrl: "https://www.zaviagent.com/workspace" };
    const r = renderBuildLiveEmail({ ...base, admin: { adminUrl: `${LIVE}/admin`, setupUrl: `${LIVE}/api/auth/magic?token=a&b` } });
    expect(r.html).toContain(`href="${LIVE}/admin?from=zavi">${LIVE}/admin?from=zavi</a>`);
    expect(r.html).toContain(`<a href="${LIVE}/api/auth/magic?token=a&amp;b">Log in to your admin</a>. One click, no password.`);
    expect(r.text).toContain(`Your site's admin page: ${LIVE}/admin?from=zavi\n`);
    expect(r.text).toContain(`Log in to your admin, one click, no password (works once, expires in 7 days): ${LIVE}/api/auth/magic?token=a&b`);
    expect(`${r.text}${r.html}`).not.toMatch(/Create your owner account|password\)/);
    expect(`${r.subject}${r.text}${r.html}`).not.toContain("—");
    expect(renderBuildLiveEmail({ ...base, admin: null })).toEqual(renderBuildLiveEmail(base));
  });
});

describe("build-live email helpers", () => {
  it("names the site from the conductor objective", () => {
    expect(siteNameFromObjective("Build product: BloodLink — Blood donation platform")).toBe("BloodLink");
    expect(siteNameFromObjective("Build product: Create a blood donation — Create a blood donation platform")).toBe(
      "Create a blood donation",
    );
    expect(siteNameFromObjective("")).toBeNull();
    expect(siteNameFromObjective("Build product: Rise &amp; Shine Bakery — A bakery &amp; cafe")).toBe("Rise & Shine Bakery");
  });

  it("prefers the served hosting URL over a domain", () => {
    expect(
      liveUrlFromResources([
        { resource_kind: "domain", status: "ready", external_ref: { hostname: "x.zaviagent.com" } },
        { resource_kind: "hosting", status: "ready", external_ref: { url: "https://bloodlink-feef248f.onrender.com" } },
      ]),
    ).toBe("https://bloodlink-feef248f.onrender.com");
    expect(
      liveUrlFromResources([{ resource_kind: "domain", status: "ready", external_ref: { hostname: "x.zaviagent.com" } }]),
    ).toBe("https://x.zaviagent.com");
    expect(
      liveUrlFromResources([{ resource_kind: "hosting", status: "failed", external_ref: { url: "https://a.onrender.com" } }]),
    ).toBeNull();
  });

  it("renders the live URL, escaped, and no em dashes", () => {
    const r = renderBuildLiveEmail({
      siteName: "Blood<Link>",
      liveUrl: "https://bloodlink-feef248f.onrender.com",
      workspaceUrl: "https://www.zaviagent.com/workspace",
    });
    expect(r.subject).toBe("Blood<Link> is live");
    expect(r.html).toContain("Blood&lt;Link&gt;");
    expect(r.html).toContain("https://bloodlink-feef248f.onrender.com");
    expect(r.text).toContain("https://bloodlink-feef248f.onrender.com");
    expect(`${r.subject}${r.text}`).not.toContain("—");
  });
});
