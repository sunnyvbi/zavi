import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireAuth: vi.fn(), role: "owner" as string }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));

import { emailPlanHandlers } from "@/routes/workspace/email-plan";

const ITEM = "11111111-1111-4111-8111-111111111111";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}

function deps(out: Record<string, unknown> = { ok: true }) {
  const calls: Array<{ tenant: string; name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    d: {
      rpc: (async (tenant: string, name: string, args: Record<string, unknown>) => {
        calls.push({ tenant, name, args });
        if (name === "email_plan_deadline_state") return { ok: true, card: { class: "email_campaign.create_and_send", body: { tool: "mailchimp" } } };
        if (name === "list_email_planned_sends") return { ok: true, role: "member", next_plan_at: null, items: [] };
        return out;
      }) as never,
      zone: async () => "America/Denver",
      count: async () => 412,
      plan: {
        zone: async () => "America/Denver",
        list: async () => ({ ok: true as const, name: "Members" }),
        rpc: (async (tenant: string, name: string, args: Record<string, unknown>) => {
          calls.push({ tenant, name, args });
          return { ok: true, id: ITEM, replayed: false };
        }) as never,
      },
    },
  };
}

beforeEach(() => {
  h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1" });
  h.role = "owner";
});

describe("email plan routes", () => {
  it("GET reads the session's workspace as the session's user (members may read)", async () => {
    h.role = "member";
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).list({ query: { tenant_id: "tenant-b" } } as never, r as never);
    expect(x.calls[0]).toMatchObject({ tenant: "tenant-a", name: "list_email_planned_sends", args: { p_user_id: "user-1" } });
    expect(r.body).toMatchObject({ ok: true, timezone: "America/Denver", items: [] });
  });

  it("F5: an owner plans an email at the wall time of the workspace's zone; a member is refused before anything runs", async () => {
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).plan(
      { body: { route: "mailchimp", list_id: "list-1", date: "2026-10-21", time: "08:15", angle: "Holiday hours", request_id: "req-12345678" } } as never,
      r as never,
    );
    expect(x.calls[0]).toMatchObject({
      tenant: "tenant-a",
      name: "plan_email_send",
      args: { p_actor: "user-1", p_source: "founder", p_planned_at: "2026-10-21T14:15:00.000Z", p_tz: "America/Denver", p_request_key: "founder:req-12345678", p_why: null },
    });
    expect(r.body).toMatchObject({ ok: true, id: ITEM });
    h.role = "member";
    const m = res();
    const y = deps();
    await emailPlanHandlers(y.d).plan({ body: { route: "mailchimp", list_id: "list-1", date: "2026-10-21", time: "08:15", angle: "Holiday hours", request_id: "req-12345678" } } as never, m as never);
    expect(m.statusCode).toBe(403);
    expect(y.calls).toEqual([]);
  });

  it("must catch N8: a replayed plan confirms the time and list the first request saved, not the edited form", async () => {
    const x = deps();
    x.d.plan.rpc = (async (_t: string, name: string) =>
      name === "plan_email_send"
        ? { ok: true, id: ITEM, replayed: true }
        : { planned_at: "2026-10-21T15:15:00.000Z", timezone: "America/Denver", list_name: "First list" }) as never;
    const r = res();
    await emailPlanHandlers(x.d).plan(
      { body: { route: "mailchimp", list_id: "list-1", date: "2026-10-23", time: "10:00", angle: "Holiday hours", request_id: "req-12345678" } } as never,
      r as never,
    );
    expect(r.body).toMatchObject({ ok: true, replayed: true, planned_at: "2026-10-21T15:15:00.000Z", list_name: "First list", label: expect.stringContaining("Oct 21") });
  });

  it("strict bodies: an extra field, a bad id or a bad time is refused", async () => {
    const x = deps();
    const a = res();
    await emailPlanHandlers(x.d).plan({ body: { route: "mailchimp", list_id: "l", date: "2026-10-21", time: "08:15", angle: "Holiday", request_id: "req-12345678", tenant_id: "tenant-b" } } as never, a as never);
    expect(a.statusCode).toBe(400);
    const b = res();
    await emailPlanHandlers(x.d).skip({ params: { id: "not-a-uuid" } } as never, b as never);
    expect(b.statusCode).toBe(404);
    const c = res();
    await emailPlanHandlers(x.d).move({ params: { id: ITEM }, body: { date: "2026-10-21", time: "25:00", schedule_gen: 1 } } as never, c as never);
    expect(c.statusCode).toBe(400);
    expect(x.calls).toEqual([]);
  });

  it("must catch: a move to a time that does not exist on the workspace's clock is refused in words", async () => {
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).move({ params: { id: ITEM }, body: { date: "2027-03-14", time: "02:30", schedule_gen: 3 } } as never, r as never);
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("nonexistent_time");
    expect(x.calls).toEqual([]);
  });

  it("H8: a move carries the zone the wall time was picked in", async () => {
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).move({ params: { id: ITEM }, body: { date: "2026-10-22", time: "09:00", schedule_gen: 2 } } as never, r as never);
    expect(x.calls[0]).toMatchObject({ name: "move_email_planned_send", args: { p_planned_at: "2026-10-22T15:00:00.000Z", p_expected_gen: 2, p_tz: "America/Denver" } });
  });

  it("must catch N5: a move converts on the clock the form showed (the item's zone), not the reporting zone; a bad zone is refused", async () => {
    const x = deps();
    await emailPlanHandlers(x.d).move({ params: { id: ITEM }, body: { date: "2026-10-22", time: "09:00", schedule_gen: 2, timezone: "Europe/London" } } as never, res() as never);
    expect(x.calls[0]).toMatchObject({ args: { p_planned_at: "2026-10-22T08:00:00.000Z", p_tz: "Europe/London" } });
    const y = deps();
    const r = res();
    await emailPlanHandlers(y.d).move({ params: { id: ITEM }, body: { date: "2026-10-22", time: "09:00", schedule_gen: 2, timezone: "Mars/Olympus" } } as never, r as never);
    expect(r.statusCode).toBe(400);
    expect(y.calls).toEqual([]);
  });

  it("Send at: the count is read now and stamped on the item by the SQL; a refusal keeps its words", async () => {
    const x = deps();
    const r = res();
    const body = { variant: 2, schedule_gen: 3, content_version: 2, request_id: "req-12345678" };
    await emailPlanHandlers(x.d).schedule({ params: { id: ITEM }, body } as never, r as never);
    expect(x.calls.map((c) => c.name)).toEqual(["email_plan_deadline_state", "schedule_email_planned_send"]);
    expect(x.calls[1].args).toEqual({
      p_actor: "user-1",
      p_id: ITEM,
      p_variant: 2,
      p_count: 412,
      p_expected_gen: 3,
      p_expected_version: 2,
      p_request_key: "schedule:req-12345678",
    });
    const z = deps();
    await emailPlanHandlers(z.d).schedule({ params: { id: ITEM }, body: { variant: 2 } } as never, res() as never);
    expect(z.calls).toEqual([]);
    const y = deps({ ok: false, code: "test_required" });
    const t = res();
    await emailPlanHandlers(y.d).schedule({ params: { id: ITEM }, body: { ...body, variant: 1 } } as never, t as never);
    expect(t.statusCode).toBe(409);
    expect(t.body.error.message).toContain("test");
  });

  it("an overridden (staff) workspace changes nothing", async () => {
    h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "staff-1", tenant_overridden: true });
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).withdraw({ params: { id: ITEM } } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(x.calls).toEqual([]);
  });

  it("not sent: the session's owner and a reason reach the SQL; a member, a bad rail or no reason never do", async () => {
    const x = deps();
    const r = res();
    await emailPlanHandlers(x.d).notSent({ params: { rail: "decisions", card_id: ITEM }, body: { reason: "  Checked Mailchimp: still a draft  " } } as never, r as never);
    expect(x.calls).toEqual([
      { tenant: "tenant-a", name: "confirm_email_not_sent", args: { p_actor_user_id: "user-1", p_rail: "decisions", p_card_id: ITEM, p_reason: "Checked Mailchimp: still a draft" } },
    ]);
    expect(r.statusCode).toBe(200);
    const bad = deps();
    for (const req of [
      { params: { rail: "other", card_id: ITEM }, body: { reason: "x" } },
      { params: { rail: "decisions", card_id: ITEM }, body: { reason: " " } },
      { params: { rail: "decisions", card_id: ITEM }, body: { reason: "x", tenant_id: "tenant-b" } },
    ]) await emailPlanHandlers(bad.d).notSent(req as never, res() as never);
    h.role = "member";
    await emailPlanHandlers(bad.d).notSent({ params: { rail: "decisions", card_id: ITEM }, body: { reason: "x" } } as never, res() as never);
    expect(bad.calls).toEqual([]);
  });

  it("not sent while the send is still going is refused in words (409)", async () => {
    const x = deps({ ok: false, code: "still_sending" });
    const r = res();
    await emailPlanHandlers(x.d).notSent({ params: { rail: "channel_actions", card_id: ITEM }, body: { reason: "checked" } } as never, r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatchObject({ code: "still_sending", message: expect.stringMatching(/still sending/) });
  });
});

describe("definite refusals are 409, a tool read failure stays 502", () => {
  const planBody = { route: "mailchimp", list_id: "list-1", date: "2026-10-21", time: "08:15", angle: "Holiday hours", request_id: "req-12345678" };

  it("count_required: no count, nothing scheduled, a 409 with words", async () => {
    const x = deps();
    x.d.count = (async () => null) as never;
    const r = res();
    await emailPlanHandlers(x.d).schedule({ params: { id: ITEM }, body: { variant: 1, schedule_gen: 3, content_version: 2, request_id: "req-12345678" } } as never, r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("count_required");
    expect(x.calls.map((c) => c.name)).toEqual(["email_plan_deadline_state"]);
  });

  it("plan_unreadable: a replay whose row cannot be read is a 409", async () => {
    const x = deps();
    x.d.plan.rpc = (async (_t: string, name: string) => (name === "plan_email_send" ? { ok: true, id: ITEM, replayed: true } : null)) as never;
    const r = res();
    await emailPlanHandlers(x.d).plan({ body: planBody } as never, r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("plan_unreadable");
  });

  it("email_tool_read_failed stays a 502", async () => {
    const x = deps();
    x.d.plan.list = (async () => ({ ok: false, code: "email_tool_read_failed" })) as never;
    const r = res();
    await emailPlanHandlers(x.d).plan({ body: planBody } as never, r as never);
    expect(r.statusCode).toBe(502);
    expect(x.calls).toEqual([]);
  });
});
