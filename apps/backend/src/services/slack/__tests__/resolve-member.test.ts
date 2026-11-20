import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const slack = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (async () => ({})) as (...a: unknown[]) => Promise<unknown>,
}));
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: (...a: unknown[]) => {
    slack.calls.push(a);
    return slack.impl(...a);
  },
}));

import {
  resolveSlackApprover,
  linkSlackMemberOnMessage,
  linkSlackInstaller,
  linkRefusal,
  slackUsersInfo,
  USERS_INFO_TIMEOUT_MS,
  type SlackUserInfo,
} from "../resolve-member";
import { buildRunActor, resolveSlackActor } from "@/services/agents/actor-envelope";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TEAM = "T_ACME";
const FOUNDER = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAMMATE = "aaaaaaaa-0000-4000-8000-000000000002";

function fakeDb(logins: Record<string, string> = { "ana@acme.com": TEAMMATE, "founder@acme.com": FOUNDER }) {
  const links = new Map<string, string>();
  const rpc = vi.fn(async (fn: string, a: Record<string, unknown>) => {
    const key = `${a.p_team_id}|${a.p_slack_user_id}`;
    if (a.p_tenant_id !== TENANT || a.p_team_id !== TEAM) return { data: null, error: null };
    if (fn === "resolve_slack_approver") return { data: links.get(key) ?? null, error: null };
    if (fn === "link_slack_identity_if_member" || fn === "link_slack_installer_identity") {
      const byEmail = logins[String(a.p_email).toLowerCase()];
      const uid = fn === "link_slack_installer_identity" ? (byEmail === a.p_user_id ? byEmail : undefined) : byEmail;
      if (!uid) return { data: null, error: null };
      const existing = links.get(key);
      if (existing && existing !== uid) return { data: null, error: null };
      links.set(key, uid);
      return { data: uid, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  return { svc: { rpc } as unknown as SupabaseClient, rpc, links };
}

const member = (over: Partial<SlackUserInfo> = {}): SlackUserInfo => ({
  id: "U_ANA",
  team_id: TEAM,
  profile: { email: "ana@acme.com", real_name: "Ana Sharma" },
  ...over,
});

beforeEach(() => {
  slack.calls = [];
  slack.impl = async () => ({});
});

describe("must-catch", () => {
  it("founder linked at OAuth connect -> a Slack Approve click resolves to that user with no users.info call", async () => {
    const db = fakeDb();
    expect(await resolveSlackApprover(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_FOUNDER" })).toBeNull();
    const usersInfo = vi.fn().mockResolvedValue(
      member({ id: "U_FOUNDER", profile: { email: "Founder@acme.com", real_name: "Fay Founder" } }),
    );
    expect(
      await linkSlackInstaller(
        db.svc,
        { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_FOUNDER", user_id: FOUNDER },
        usersInfo,
      ),
    ).toBe(FOUNDER);
    expect(db.rpc).toHaveBeenCalledWith("link_slack_installer_identity", {
      p_tenant_id: TENANT,
      p_team_id: TEAM,
      p_slack_user_id: "U_FOUNDER",
      p_user_id: FOUNDER,
      p_email: "Founder@acme.com",
      p_display_name: "Fay Founder",
    });
    usersInfo.mockClear();
    expect(await resolveSlackApprover(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_FOUNDER" })).toBe(FOUNDER);
    expect(usersInfo).not.toHaveBeenCalled();
    expect(slack.calls).toEqual([]);
  });

  it("must-not: a connect link opened in someone else's Slack (email is not the connecting login) links nobody", async () => {
    const db = fakeDb();
    const usersInfo = vi.fn().mockResolvedValue(member());
    expect(
      await linkSlackInstaller(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA", user_id: FOUNDER }, usersInfo),
    ).toBeNull();
    expect(db.links.size).toBe(0);
  });

  it("must-not: the installer path refuses a guest / missing email / users.info error, without calling the link RPC", async () => {
    for (const info of [
      vi.fn().mockResolvedValue(member({ id: "U_FOUNDER", is_restricted: true, profile: { email: "founder@acme.com" } })),
      vi.fn().mockResolvedValue(member({ id: "U_FOUNDER", profile: {} })),
      vi.fn().mockRejectedValue(new Error("slack down")),
    ]) {
      const db = fakeDb();
      expect(
        await linkSlackInstaller(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_FOUNDER", user_id: FOUNDER }, info),
      ).toBeNull();
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });

  it("a teammate who sent a Slack message is linked when users.info email matches a same-tenant login, and their later click resolves", async () => {
    const db = fakeDb();
    const usersInfo = vi.fn().mockResolvedValue(member({ profile: { email: "Ana@Acme.com", real_name: "Ana Sharma" } }));
    const env = await resolveSlackActor(db.svc, TENANT, "U_ANA", TEAM, { linkOnMiss: true, usersInfo });
    expect(env).toMatchObject({ actor_user_id: TEAMMATE, resolved_tenant_member: true });
    expect(db.rpc).toHaveBeenCalledWith("link_slack_identity_if_member", {
      p_tenant_id: TENANT,
      p_team_id: TEAM,
      p_slack_user_id: "U_ANA",
      p_email: "Ana@Acme.com",
      p_display_name: "Ana Sharma",
    });
    usersInfo.mockClear();
    expect(await resolveSlackApprover(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" })).toBe(TEAMMATE);
    expect(usersInfo).not.toHaveBeenCalled();
    expect(slack.calls).toEqual([]);
  });

  it("a Slack run gets actor_user_id set (worker actor resolution links on first message, via the real users.info wrapper)", async () => {
    const db = fakeDb();
    slack.impl = async () => ({ ok: true, user: member() });
    const env = await buildRunActor(db.svc, "slack", {
      tenant_id: TENANT,
      slack_user_id: "U_ANA",
      slack_team_id: TEAM,
      link_slack_on_miss: true,
    });
    expect(env.actor_user_id).toBe(TEAMMATE);
    expect(env.provenance_label).toBe("verified member");
    expect(slack.calls).toEqual([[TENANT, "users.info", { user: "U_ANA" }, TEAM, { noLegacyFallback: true }]]);
  });

  it("an already-linked sender resolves without calling users.info", async () => {
    const db = fakeDb();
    db.links.set(`${TEAM}|U_ANA`, TEAMMATE);
    const usersInfo = vi.fn();
    const env = await resolveSlackActor(db.svc, TENANT, "U_ANA", TEAM, { linkOnMiss: true, usersInfo });
    expect(env.actor_user_id).toBe(TEAMMATE);
    expect(usersInfo).not.toHaveBeenCalled();
  });
});

describe("must-not", () => {
  it.each([
    ["a guest (restricted)", member({ is_restricted: true })],
    ["a single-channel guest (ultra-restricted)", member({ is_ultra_restricted: true })],
    ["a bot", member({ is_bot: true })],
    ["an app user", member({ is_app_user: true })],
    ["a deleted user", member({ deleted: true })],
    ["a Slack Connect stranger", member({ is_stranger: true })],
    ["a user of another workspace (team mismatch)", member({ team_id: "T_OTHER" })],
    ["Slackbot", member({ id: "USLACKBOT" })],
    ["a profile with no email", member({ profile: { real_name: "Ana" } })],
    ["users.info for a different id", member({ id: "U_SOMEONE_ELSE" })],
  ])("%s is never linked (no link RPC)", async (_label, user) => {
    const db = fakeDb();
    const id = user.id === "USLACKBOT" ? "USLACKBOT" : "U_ANA";
    const usersInfo = vi.fn().mockResolvedValue(user);
    expect(await linkSlackMemberOnMessage(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: id }, usersInfo)).toBeNull();
    expect(db.rpc).not.toHaveBeenCalledWith("link_slack_identity_if_member", expect.anything());
  });

  it("an email that is not a login of this tenant -> no link (the RPC refuses)", async () => {
    const db = fakeDb();
    const usersInfo = vi.fn().mockResolvedValue(member({ profile: { email: "stranger@else.com" } }));
    const env = await resolveSlackActor(db.svc, TENANT, "U_ANA", TEAM, { linkOnMiss: true, usersInfo });
    expect(env.actor_user_id).toBeNull();
    expect(db.links.size).toBe(0);
  });

  it("a team_id of another tenant -> null", async () => {
    const db = fakeDb();
    db.links.set(`${TEAM}|U_ANA`, TEAMMATE);
    expect(await resolveSlackApprover(db.svc, { tenant_id: TENANT, team_id: "T_OTHER", slack_user_id: "U_ANA" })).toBeNull();
  });

  it("no team_id -> null, nothing called (the resolver is team-aware and fails closed)", async () => {
    const db = fakeDb();
    expect(await resolveSlackApprover(db.svc, { tenant_id: TENANT, team_id: null, slack_user_id: "U_ANA" })).toBeNull();
    const usersInfo = vi.fn();
    expect(await linkSlackMemberOnMessage(db.svc, { tenant_id: TENANT, team_id: "", slack_user_id: "U_ANA" }, usersInfo)).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(usersInfo).not.toHaveBeenCalled();
  });

  it("an existing link to another member is not moved; the link returns null and the click still resolves to the original", async () => {
    const db = fakeDb();
    db.links.set(`${TEAM}|U_ANA`, FOUNDER);
    const usersInfo = vi.fn().mockResolvedValue(member());
    expect(await linkSlackMemberOnMessage(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" }, usersInfo)).toBeNull();
    expect(db.links.get(`${TEAM}|U_ANA`)).toBe(FOUNDER);
  });

  it("without linkOnMiss (the default) an unlinked sender is never looked up", async () => {
    const db = fakeDb();
    const usersInfo = vi.fn();
    const env = await resolveSlackActor(db.svc, TENANT, "U_ANA", TEAM, { usersInfo });
    expect(env.actor_user_id).toBeNull();
    expect(usersInfo).not.toHaveBeenCalled();
  });
});

describe("fails closed on Slack or DB trouble", () => {
  it("users.info error -> null, no link", async () => {
    const db = fakeDb();
    slack.impl = async () => {
      throw new Error("slack_api_error");
    };
    expect(await linkSlackMemberOnMessage(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" })).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("users.info slower than the cut-off -> null", async () => {
    expect(USERS_INFO_TIMEOUT_MS).toBeLessThanOrEqual(1000);
    slack.impl = () => new Promise(() => {});
    expect(await slackUsersInfo({ tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" }, 20)).toBeNull();
  });

  it("link RPC error or throw -> null; resolver RPC error or throw -> null", async () => {
    const usersInfo = vi.fn().mockResolvedValue(member());
    const errSvc = { rpc: vi.fn().mockResolvedValue({ data: "x", error: { code: "XX000" } }) } as unknown as SupabaseClient;
    const throwSvc = { rpc: vi.fn().mockRejectedValue(new Error("down")) } as unknown as SupabaseClient;
    for (const svc of [errSvc, throwSvc]) {
      expect(await linkSlackMemberOnMessage(svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" }, usersInfo)).toBeNull();
      expect(await resolveSlackApprover(svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA" })).toBeNull();
      expect(
        await linkSlackInstaller(
          svc,
          { tenant_id: TENANT, team_id: TEAM, slack_user_id: "U_ANA", user_id: TEAMMATE },
          usersInfo,
        ),
      ).toBeNull();
    }
  });

  it("installer link without an authed_user_id does nothing", async () => {
    const db = fakeDb();
    expect(await linkSlackInstaller(db.svc, { tenant_id: TENANT, team_id: TEAM, slack_user_id: "", user_id: FOUNDER })).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("linkRefusal", () => {
  it("accepts a full member of this workspace with an email", () => {
    expect(linkRefusal(member(), TEAM, "U_ANA")).toBeNull();
  });
  it("refuses a missing profile", () => {
    expect(linkRefusal(null, TEAM, "U_ANA")).toBe("no_user");
  });
});
