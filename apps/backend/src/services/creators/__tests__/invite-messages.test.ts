import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, ...unknown[]];
const m = vi.hoisted(() => ({
  answer: (_table: string, _calls: Call[]): { data?: unknown; error?: unknown; count?: number } => ({ data: null, error: null }),
  queries: [] as Array<{ table: string; calls: Call[] }>,
  rpc: vi.fn(),
  tenantInserts: [] as unknown[],
}));

function builder(table: string) {
  const calls: Call[] = [];
  m.queries.push({ table, calls });
  const b: Record<string, unknown> = {};
  for (const name of ["select", "not", "is", "eq", "in", "order", "range", "maybeSingle", "insert", "update", "limit", "or"]) {
    b[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return b;
    };
  }
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, ...m.answer(table, calls) }).then(ok, bad);
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({ from: (t: string) => builder(t) }),
  tenantClient: () => ({ from: (t: string) => builder(t) }),
  creatorAreaClient: () => ({ from: (t: string) => builder(t) }),
  asTenantId: (t: string) => t,
  creatorInviteRpc: (name: string, args: unknown) => m.rpc(name, args),
}));
vi.mock("../briefs-db", () => ({ resolveBusinessName: async () => "Acme <Shoes>" }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/agents/entitlement", () => ({ resolveInviteEmailCap: async () => ({ tier: "free", cap: 3, higherPlanAllowsMore: true }) }));
vi.mock("../thread", () => ({ ensureCreatorThread: vi.fn(), MAX_CREATOR_MESSAGE_LEN: 4000 }));

import { ensureCreatorThread } from "../thread";
import {
  InviteMessageError,
  carryInviteMessages,
  countInvitedCreators,
  inviteSocials,
  postInviteMessage,
  prefillInviteAccounts,
  searchInvitedCreators,
} from "../invite-messages";
import { renderInviteMessageEmail } from "@/email/templates/creator-invite-message";

const INVITE = "11111111-1111-4111-8111-111111111111";
const visibleRow = {
  id: INVITE,
  email: "leak-sentinel@example.com",
  display_name: "Ivy Lane",
  profiles: { instagram: { url: "https://instagram.com/ivy", handle: "ivy" } },
  followers: { instagram: { raw: "12k", n: 12000 } },
  invited_at: "2026-10-01T00:00:00Z",
};
const env = { PRAXIS_PUBLIC_BASE: "https://www.zaviagent.com", BACKEND_PUBLIC_URL: "https://api.zaviagent.com" };
const growth = async () => ({ tier: "growth" as const, cap: 25, higherPlanAllowsMore: true });
const hasCall = (calls: Call[], ...want: unknown[]) => calls.some((c) => JSON.stringify(c) === JSON.stringify(want));

beforeEach(() => {
  m.queries.length = 0;
  m.rpc.mockReset();
  m.answer = (table, calls) => {
    if (table === "creator_invites" && hasCall(calls, "select", "email, unsub_token, signup_token")) {
      return {
        data: { email: "ivy@example.com", unsub_token: "22222222-2222-4222-8222-222222222222", signup_token: "33333333-3333-4333-8333-333333333333" },
      };
    }
    if (table === "creator_invites") return { data: visibleRow };
    if (table === "creator_invite_messages" && calls.some((c) => c[0] === "insert")) {
      return { data: { id: "msg-1", body: (calls.find((c) => c[0] === "insert")![1] as { body: string }).body, created_at: "2026-10-02T00:00:00Z", emailed_at: null } };
    }
    if (table === "creator_invite_messages") return { count: 0, data: null };
    return { data: null };
  };
});

describe("inviteSocials", () => {
  it("keeps links with a handle, strips @, carries the parsed follower number", () => {
    const out = inviteSocials({
      profiles: { instagram: { handle: "@ivy" }, x: { url: "https://x.com/" }, youtube: { handle: "ivyvids" } },
      followers: { instagram: { n: 12000 }, youtube: { raw: "lots", n: null } },
    });
    expect(out.map((s) => [s.platform, s.handle, s.followers])).toEqual([
      ["instagram", "ivy", 12000],
      ["youtube", "ivyvids", null],
    ]);
  });
});

describe("searchInvitedCreators", () => {
  const base = { order: "newest" as const, lane: null, platform: null, needsMemberData: false, limit: 50, offset: 0 };

  it("returns none, without reading, for filters an invite has no data for", async () => {
    expect(await searchInvitedCreators({ ...base, needsMemberData: true })).toEqual([]);
    expect(await searchInvitedCreators({ ...base, lane: "audience_post" })).toEqual([]);
    expect(await searchInvitedCreators({ ...base, platform: "tiktok" })).toEqual([]);
    expect(m.queries).toHaveLength(0);
  });

  it("reads only emailed, unclaimed, reachable invites and never returns an email", async () => {
    m.answer = () => ({ data: [visibleRow] });
    const out = await searchInvitedCreators({ ...base, lane: "ugc_video", platform: "instagram" });
    const calls = m.queries[0].calls;
    for (const col of ["human_member_id", "claimed_at", "member_deleted_at", "unsubscribed_at", "bounced_at", "send_failed_at", "hold_reason"]) {
      expect(hasCall(calls, "is", col, null)).toBe(true);
    }
    expect(hasCall(calls, "not", "invited_at", "is", null)).toBe(true);
    expect(hasCall(calls, "not", "profiles->instagram", "is", null)).toBe(true);
    expect(out[0]).toMatchObject({ human_member_id: `invite:${INVITE}`, invited: true, bookable: false, packages: [] });
    expect(JSON.stringify(out)).not.toContain("leak-sentinel");
    expect(out[0]).not.toHaveProperty("email");
  });
});

describe("postInviteMessage", () => {
  const args = { tenant_id: "t1", user_id: "u1", invite_id: INVITE, body: "Love your work! write me at me@acme.com" };

  it("stores the scrubbed message and emails it when the cap allows", async () => {
    m.rpc.mockResolvedValue({ data: "claimed", error: null });
    const send = vi.fn().mockResolvedValue(undefined);
    const out = await postInviteMessage(args, { send, env, inviteCap: growth });
    expect(m.rpc).toHaveBeenCalledWith("creator_invite_message_claim_email", { p_message_id: "msg-1", p_daily_cap: 25 });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, , text, , opts] = send.mock.calls[0];
    expect(to).toBe("ivy@example.com");
    expect(subject).toBe("Acme <Shoes> sent you a message on Zavi");
    expect(text).not.toContain("me@acme.com");
    expect(text).toContain("https://www.zaviagent.com/creators/login?src=invite_message&invite=33333333-3333-4333-8333-333333333333");
    expect(opts.customArgs).toEqual({ creator_invite_id: INVITE });
    expect(opts.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(out.message.emailed).toBe(true);
    expect(out.message.body).not.toContain("me@acme.com");
  });

  it("stores but does not email when a per-invitee cap refuses", async () => {
    m.rpc.mockResolvedValue({ data: "invitee_weekly_cap", error: null });
    const send = vi.fn();
    const out = await postInviteMessage(args, { send, env, inviteCap: growth });
    expect(send).not.toHaveBeenCalled();
    expect(out.message.emailed).toBe(false);
    expect(out.email_note).toMatch(/see this message when they join/);
    expect(out.email_note).not.toMatch(/limit/);
  });

  it("uses the billing-resolved cap by default (Free = 3)", async () => {
    m.rpc.mockResolvedValue({ data: "claimed", error: null });
    await postInviteMessage(args, { send: vi.fn().mockResolvedValue(undefined), env });
    expect(m.rpc).toHaveBeenCalledWith("creator_invite_message_claim_email", { p_message_id: "msg-1", p_daily_cap: 3 });
  });

  it("a cap that cannot be resolved sends nothing and does not blame the plan", async () => {
    const send = vi.fn();
    const out = await postInviteMessage(args, {
      send,
      env,
      inviteCap: async () => {
        throw new Error("system_config read failed");
      },
    });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(out.message.emailed).toBe(false);
    expect(out.email_note).toMatch(/could not confirm an email/);
    expect(out.email_note).not.toMatch(/limit/);
  });

  it("never calls the claim with a cap outside 0..1000", async () => {
    for (const cap of [-1, 1001, 2.5, Number.NaN]) {
      m.rpc.mockReset();
      const send = vi.fn();
      const out = await postInviteMessage(args, { send, env, inviteCap: async () => ({ tier: "pro", cap, higherPlanAllowsMore: false }) });
      expect(m.rpc).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(out.message.emailed).toBe(false);
    }
  });

  it("gives the email slot back when SendGrid rejects the send", async () => {
    m.rpc.mockResolvedValue({ data: "claimed", error: null });
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { code: 400, response: {} }));
    const out = await postInviteMessage(args, { send, env });
    expect(out.message.emailed).toBe(false);
    const release = m.queries.find((q) => q.table === "creator_invite_messages" && hasCall(q.calls, "update", { emailed_at: null }));
    expect(release).toBeTruthy();
  });

  it("404s an invite search would not show, before storing anything", async () => {
    m.answer = () => ({ data: null });
    await expect(postInviteMessage(args, { send: vi.fn(), env })).rejects.toMatchObject({ code: "invite_not_found", status: 404 });
    expect(m.queries.some((q) => q.calls.some((c) => c[0] === "insert"))).toBe(false);
  });

  it("refuses past the per-business message limit", async () => {
    const answer = m.answer;
    m.answer = (table, calls) => (table === "creator_invite_messages" ? { count: 20 } : answer(table, calls));
    await expect(postInviteMessage(args, { send: vi.fn(), env })).rejects.toBeInstanceOf(InviteMessageError);
  });
});

describe("per-plan daily invitee-email cap", () => {
  const args = { tenant_id: "t1", user_id: "u1", invite_id: INVITE, body: "Hi there" };

  function capRpc() {
    let claims = 0;
    m.rpc.mockImplementation(async (_name: string, a: { p_daily_cap: number }) => {
      if (claims >= a.p_daily_cap) return { data: "business_daily_cap", error: null };
      claims += 1;
      return { data: "claimed", error: null };
    });
  }

  async function sendN(n: number, tier: "free" | "pro") {
    const send = vi.fn().mockResolvedValue(undefined);
    const cap = tier === "free" ? 3 : 50;
    const outs = [];
    for (let i = 0; i < n; i++) outs.push(await postInviteMessage(args, { send, env, inviteCap: async () => ({ tier, cap, higherPlanAllowsMore: tier !== "pro" }) }));
    return { outs, send };
  }

  it("Free = 3: the 4th invitee email is refused, plainly, with a higher-plan hint and no price", async () => {
    capRpc();
    const { outs, send } = await sendN(4, "free");
    expect(send).toHaveBeenCalledTimes(3);
    expect(outs.slice(0, 3).every((o) => o.message.emailed)).toBe(true);
    expect(outs[3].message.emailed).toBe(false);
    expect(outs[3].email_note).toMatch(/reached today's limit for messaging invited creators on your plan/);
    expect(outs[3].email_note).toMatch(/higher plan allows more/);
    expect(outs[3].email_note).not.toMatch(/\$|\d+ ?(usd|dollars)/i);
  });

  it("Pro = 50: 50 go, the 51st is refused, with no upgrade hint", async () => {
    capRpc();
    const { outs, send } = await sendN(51, "pro");
    expect(send).toHaveBeenCalledTimes(50);
    expect(outs[50].message.emailed).toBe(false);
    expect(outs[50].email_note).toMatch(/reached today's limit/);
    expect(outs[50].email_note).not.toMatch(/higher plan/);
  });
});

describe("carryInviteMessages", () => {
  it("skips messages already copied, so a retry after a partial failure never duplicates", async () => {
    vi.mocked(ensureCreatorThread).mockResolvedValue({ id: "thread-1" } as never);
    const inserted: unknown[] = [];
    m.answer = (table, calls) => {
      if (table === "creator_invites") return { data: [{ id: INVITE }] };
      if (table === "creator_invite_messages" && calls.some((c) => c[0] === "select")) {
        return {
          data: [
            { id: "m1", tenant_id: "t1", sender_user_id: "u1", body: "first", created_at: "2026-10-01T00:00:00Z" },
            { id: "m2", tenant_id: "t1", sender_user_id: "u1", body: "second", created_at: "2026-10-01T00:01:00Z" },
          ],
        };
      }
      if (table === "creator_thread_messages" && calls.some((c) => c[0] === "insert")) {
        inserted.push(...(calls.find((c) => c[0] === "insert")![1] as unknown[]));
        return {};
      }
      if (table === "creator_thread_messages") return { data: [{ id: "m1" }] };
      return {};
    };
    expect(await carryInviteMessages("member-1")).toBe(2);
    expect(inserted).toEqual([expect.objectContaining({ id: "m2", thread_id: "thread-1", body: "second" })]);
    const mark = m.queries.find((q) => q.table === "creator_invite_messages" && q.calls.some((c) => c[0] === "update"));
    expect(mark && hasCall(mark.calls, "in", "id", ["m1", "m2"])).toBe(true);
    const bump = m.queries.find((q) => q.table === "creator_threads" && q.calls.some((c) => c[0] === "update"));
    expect(bump && hasCall(bump.calls, "or", "last_message_at.is.null,last_message_at.lt.2026-10-01T00:01:00Z")).toBe(true);
  });
});

describe("renderInviteMessageEmail", () => {
  const mail = renderInviteMessageEmail({
    name: "Ivy Lane",
    businessName: "<script>alert(1)</script>\nBcc: x@y.com",
    signupUrl: "https://www.zaviagent.com/creators/apply?src=invite",
    unsubscribeUrl: "https://api.zaviagent.com/api/creators/invite/unsubscribe?t=abc",
    siteUrl: "https://www.zaviagent.com",
  });

  it("keeps the subject on one line, escapes the brand, and greets by first name", () => {
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).toContain("Hi Ivy,");
    expect(mail.text).toContain("View request");
  });

  it("carries the unsubscribe link and the postal address in both parts", () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("/api/creators/invite/unsubscribe?t=abc");
      expect(part).toContain("/creators/apply?src=invite");
    }
  });
});

describe("prefillInviteAccounts", () => {
  const inserts = () =>
    m.queries.filter((q) => q.table === "human_member_handles" && q.calls.some((c) => c[0] === "insert")).map((q) => q.calls.find((c) => c[0] === "insert")![1]);

  it("adds the invite's links and follower numbers to a creator with no accounts", async () => {
    m.answer = (table, calls) => {
      if (table === "human_member_handles" && calls.some((c) => c[0] === "insert")) return { data: null };
      if (table === "human_member_handles") return { data: [] };
      if (table === "creator_invites") {
        return {
          data: [
            {
              profiles: { instagram: { url: "https://instagram.com/ivy", handle: "ivy" }, x: { url: "https://x.com/ivyx", handle: "ivyx" } },
              followers: { instagram: { raw: "12k", n: 12000 } },
            },
          ],
        };
      }
      return { data: null };
    };
    expect(await prefillInviteAccounts("member-1")).toBe(2);
    expect(inserts()).toEqual([
      { human_member_id: "member-1", platform: "instagram", handle: "ivy", followers: 12000 },
      { human_member_id: "member-1", platform: "x", handle: "ivyx", followers: null },
    ]);
    const invRead = m.queries.find((q) => q.table === "creator_invites")!.calls;
    expect(hasCall(invRead, "eq", "human_member_id", "member-1")).toBe(true);
  });

  it("never touches a creator who already has accounts", async () => {
    m.answer = (table) => (table === "human_member_handles" ? { data: [{ id: "h1" }] } : { data: [visibleRow] });
    expect(await prefillInviteAccounts("member-1")).toBe(0);
    expect(inserts()).toHaveLength(0);
    expect(m.queries.some((q) => q.table === "creator_invites")).toBe(false);
  });

  it("skips a handle another creator holds and keeps the rest", async () => {
    let n = 0;
    m.answer = (table, calls) => {
      if (table === "human_member_handles" && calls.some((c) => c[0] === "insert")) {
        return n++ === 0 ? { error: { message: "duplicate key" } } : { data: null };
      }
      if (table === "human_member_handles") return { data: [] };
      if (table === "creator_invites") {
        return { data: [{ profiles: { instagram: { handle: "taken" }, youtube: { handle: "ivyvids" } }, followers: {} }] };
      }
      return { data: null };
    };
    expect(await prefillInviteAccounts("member-1")).toBe(1);
  });
});

describe("countInvitedCreators", () => {
  const base = { lane: null, platform: null, needsMemberData: false };

  it("counts only invites the search would list, across every page", async () => {
    m.answer = () => ({ count: 931, data: null });
    expect(await countInvitedCreators(base)).toBe(931);
    const calls = m.queries[0].calls;
    expect(hasCall(calls, "select", "id", { count: "exact", head: true })).toBe(true);
    for (const col of ["human_member_id", "claimed_at", "member_deleted_at", "unsubscribed_at", "bounced_at", "send_failed_at", "hold_reason"]) {
      expect(hasCall(calls, "is", col, null)).toBe(true);
    }
    expect(hasCall(calls, "not", "invited_at", "is", null)).toBe(true);
  });

  it("applies the platform filter, and is 0 without a read when no invite can match", async () => {
    m.answer = () => ({ count: 12, data: null });
    expect(await countInvitedCreators({ ...base, platform: "youtube" })).toBe(12);
    expect(hasCall(m.queries[0].calls, "not", "profiles->youtube", "is", null)).toBe(true);
    m.queries.length = 0;
    expect(await countInvitedCreators({ ...base, needsMemberData: true })).toBe(0);
    expect(await countInvitedCreators({ ...base, lane: "audience_post" })).toBe(0);
    expect(await countInvitedCreators({ ...base, platform: "tiktok" })).toBe(0);
    expect(m.queries).toHaveLength(0);
  });
});
