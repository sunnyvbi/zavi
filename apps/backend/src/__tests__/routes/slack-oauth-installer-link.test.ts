import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FOUNDER = "aaaaaaaa-0000-4000-8000-000000000001";
const LOGIN_EMAIL: Record<string, string> = { [FOUNDER]: "founder@acme.com" };

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  slackUser: null as unknown,
  slackError: null as Error | null,
}));

vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "insert", "update"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (r: (v: unknown) => void) => r({ data: null, error: null });
  const rpc = async (fn: string, a: Record<string, unknown>) => {
    h.rpcCalls.push([fn, a]);
    if (fn === "consume_oauth_state") return { data: [{ tenant_id: TENANT, user_id: FOUNDER }], error: null };
    if (fn === "link_slack_installer_identity") {
      const ok = String(a.p_email ?? "").toLowerCase() === LOGIN_EMAIL[a.p_user_id as string];
      return { data: ok ? a.p_user_id : null, error: null };
    }
    return { data: null, error: null };
  };
  return { serviceClient: () => ({ rpc, from: () => chain }) };
});
vi.mock("@/services/connectors/slack/oauth", () => ({
  slackOAuthStartUrl: () => "https://slack.test/oauth",
  BOT_SCOPES_VERSION: 4,
  exchangeCode: async () => ({
    access_token: "xoxb-test",
    team_id: "T_ACME",
    team_name: "Acme",
    scope: "chat:write,users:read,users:read.email",
    bot_user_id: "B1",
    authed_user_id: "U_INSTALLER",
  }),
}));
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: async (_t: string, method: string) => {
    if (method !== "users.info") throw new Error(`unexpected ${method}`);
    if (h.slackError) throw h.slackError;
    return { ok: true, user: h.slackUser };
  },
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => {}) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => {}) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }));

import { slackCallback } from "../../routes/connectors/slack";

function run() {
  let location = "";
  const res = { redirect: (_s: number, url: string) => { location = url; } } as unknown as Response;
  const req = { query: { code: "c", state: "s" } } as unknown as Request;
  return slackCallback(req, res).then(() => location);
}

const installer = (email: string | undefined, over: Record<string, unknown> = {}) => ({
  id: "U_INSTALLER",
  team_id: "T_ACME",
  profile: email === undefined ? {} : { email, real_name: "Fay Founder" },
  ...over,
});

const linkCalls = () => h.rpcCalls.filter(([fn]) => fn === "link_slack_installer_identity");

beforeEach(() => {
  h.rpcCalls = [];
  h.slackError = null;
  h.slackUser = null;
});

describe("Slack OAuth callback: installer link", () => {
  it("installer's Slack email = the connecting login -> linked; connect succeeds", async () => {
    h.slackUser = installer("Founder@Acme.com");
    const loc = await run();
    expect(loc).toContain("slack=connected");
    expect(linkCalls()).toEqual([
      ["link_slack_installer_identity", {
        p_tenant_id: TENANT, p_team_id: "T_ACME", p_slack_user_id: "U_INSTALLER",
        p_user_id: FOUNDER, p_email: "Founder@Acme.com", p_display_name: "Fay Founder",
      }],
    ]);
  });

  it("must-not: a different Slack email (connect link opened in someone else's Slack) -> not linked; connect still succeeds", async () => {
    h.slackUser = installer("ana@acme.com");
    const loc = await run();
    expect(loc).toContain("slack=connected");
    expect(loc).not.toContain("slack_error");
    expect(linkCalls()).toHaveLength(1);
  });

  it.each([
    ["no email on the profile", () => { h.slackUser = installer(undefined); }],
    ["a guest", () => { h.slackUser = installer("founder@acme.com", { is_restricted: true }); }],
    ["users.info fails", () => { h.slackError = new Error("slack down"); }],
  ])("must-not: %s -> link skipped, connect still succeeds", async (_l, setup) => {
    setup();
    const loc = await run();
    expect(loc).toContain("slack=connected");
    expect(linkCalls()).toHaveLength(0);
  });
});
