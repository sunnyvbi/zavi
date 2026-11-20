import { describe, expect, it, vi } from "vitest";
import { makeListPlanTool, makePlanSendTool, type RunContext } from "@/services/tools/email/plan_send";
import { makeProposeCampaignTool, type PlanRunContext, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import type { EmailContent, EmailTemplate } from "@/services/email-templates/render";
import { plannedListSendRefusal } from "../list-door";
import { movePlanned } from "../api";
import { planRefusal } from "../messages";
import { isPlannedCard } from "@/services/growth/cgo-email";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const T = "tenant-brightloop";
const RUN = "55555555-5555-4555-8555-555555555555";
const ITEM = "11111111-1111-4111-8111-111111111111";
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";

const ctx = (over: Record<string, unknown> = {}) => ({ tenant_id: T, run_id: RUN, log: () => {}, ...over }) as never;

describe("email__plan_send", () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const tool = (run: RunContext, rpcOut: Record<string, unknown> = { ok: true, id: ITEM, replayed: false }) =>
    makePlanSendTool({
      runContext: async () => run,
      plan: {
        zone: async () => "America/Chicago",
        list: async () => ({ ok: true, name: "Brightloop members" }),
        prior: async () => null,
        rpc: (async (_t: string, _n: string, args: Record<string, unknown>) => {
          rpcCalls.push(args);
          return rpcOut;
        }) as never,
      },
    });
  const args = { route: "sendgrid", audience_id: SG_LIST, date: "2026-10-21", time: "10:00", angle: "Shared workspaces are here", why: "Feature emails beat the line twice in September" };

  it("plans as the email agent at the instant of that wall time; files no card", async () => {
    rpcCalls.length = 0;
    const out = await tool({ found: true, mode: "weekly_plan", briefed: false }).execute(ctx(), args as never);
    expect(rpcCalls[0]).toMatchObject({
      p_actor: null,
      p_source: "email_agent",
      p_route: "sendgrid",
      p_list_id: SG_LIST,
      p_list_name: "Brightloop members",
      p_planned_at: "2026-10-21T15:00:00.000Z",
      p_tz: "America/Chicago",
      p_request_key: `run:${RUN}:sendgrid:${SG_LIST}:2026-10-21`,
    });
    expect(out).toMatchObject({ planned: { id: ITEM, list: "Brightloop members", when: "Wed, Oct 21, 10:00 (America/Chicago)" } });
  });

  it("a run cgo briefed plans as the Growth agent", async () => {
    rpcCalls.length = 0;
    await tool({ found: true, mode: null, briefed: true }).execute(ctx(), args as never);
    expect(rpcCalls[0].p_source).toBe("growth_agent");
  });

  it("must catch R7: a planned-draft run may not plan, a shadow run writes nothing, an unreadable run plans nothing", async () => {
    await expect(tool({ found: true, mode: "planned_draft" }).execute(ctx(), args as never)).rejects.toMatchObject({ code: "plan_run_drafts_only" });
    await expect(tool({ found: true, mode: null }).execute(ctx({ writes_suppressed: true }), args as never)).rejects.toMatchObject({ code: "plan_writes_suppressed" });
    const broken = makePlanSendTool({
      runContext: async () => {
        throw new Error("db");
      },
    });
    await expect(broken.execute(ctx(), args as never)).rejects.toMatchObject({ code: "plan_unreadable" });
  });

  it("a rule the SQL refuses reaches the agent in words", async () => {
    await expect(tool({ found: true, mode: null }, { ok: false, code: "week_full" }).execute(ctx(), args as never)).rejects.toMatchObject({
      code: "email_plan_week_full",
      message: expect.stringContaining("3 planned emails"),
    });
    await expect(tool({ found: true, mode: null }).execute(ctx(), { ...args, list_id: ITEM } as never)).rejects.toMatchObject({ code: "email_list_required" });
  });

  it("email__list_plan reads the queue on the workspace's clock, with who planned it and why it did not go", async () => {
    const list = makeListPlanTool({
      list: async () => ({
        ok: true,
        next_plan_at: "2026-10-26T13:00:00Z",
        items: [
          { id: ITEM, route: "zavi_list", list_id: "L", list_name: "Patients", planned_at: "2026-10-21T15:00:00Z", timezone: "America/Chicago", angle: "Flu shots", why: null, source: "growth_agent", status: "skipped", status_reason: "not_approved_in_time", card: null },
        ],
      }),
    });
    const out = (await list.execute(ctx(), {})) as { items: Array<Record<string, unknown>> };
    expect(out.items[0]).toMatchObject({ list: "Patients", when: "Wed, Oct 21, 10:00", by: "the Growth agent", status: "skipped", reason: "Not approved by the planned time. The draft is still there." });
  });
});

const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#1a73e8",
  button_color: "#0b8043",
  font_key: "system",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};
const version: EmailContent = {
  subject: "Shared workspaces are here",
  preview_text: "One link for the whole team",
  title: "Shared workspaces",
  paragraphs: ["Invite your team to one workspace."],
  button: { label: "See what changed", url: "https://brightloop.test/changelog" },
};

describe("email__propose_campaign on a planned-draft run (R7)", () => {
  function propose(run: PlanRunContext | Error, over: Partial<ProposeCampaignDeps> = {}) {
    const sg = fakeSendgrid();
    const emit = vi.fn(async () => "44444444-4444-4444-8444-444444444444");
    const attach = vi.fn(async () => ({ ok: true }));
    const discard = vi.fn(async () => true);
    const tool = makeProposeCampaignTool({
      resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: sendgridKeyDigest(BRIGHTLOOP_KEY) } })) as never,
      callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
      template: async () => TEMPLATE,
      company: async () => ({ name: "Brightloop", website: "https://brightloop.test" }),
      testLists: async () => new Set<string>(),
      setting: async () => null,
      railOf: async () => "channel_actions",
      runContext: async () => {
        if (run instanceof Error) throw run;
        return run;
      },
      attachPlanned: attach,
      discardPlanned: discard,
      reserveCard: async () => ({ ok: true, id: "reservation-1" }),
      releaseCard: async () => undefined,
      settleCard: async () => undefined,
      now: () => new Date("2026-10-20T12:00:00Z"),
      ...over,
    });
    return { run: (a: Record<string, unknown> = {}) => tool.execute(ctx({ emit_decision: emit }), { route: "sendgrid", audience_id: SG_LIST, variants: [version], ...a } as never), emit, attach, discard };
  }
  const bound: PlanRunContext = { found: true, mode: "planned_draft", item_id: ITEM, version: 2, stale: false, route: "sendgrid", list_id: SG_LIST };

  it("seals the item and version into the card and attaches it under the item's lock", async () => {
    const p = propose(bound);
    const out = await p.run();
    expect((p.emit.mock.calls[0] as unknown[])[1]).toMatchObject({ planned_send_id: ITEM, plan_version: 2 });
    expect(p.attach).toHaveBeenCalledWith(T, { item_id: ITEM, version: 2, run_id: RUN, rail: "channel_actions", id: "44444444-4444-4444-8444-444444444444" });
    expect(out).toMatchObject({ planned: true, note: expect.stringContaining("planned time") });
  });

  it("must catch: an attach refused (the plan changed while it ran) closes the new card and says so", async () => {
    const p = propose(bound, { attachPlanned: async () => ({ ok: false, code: "plan_changed" }) });
    await expect(p.run()).rejects.toMatchObject({ code: "email_plan_changed" });
    expect(p.discard).toHaveBeenCalledWith(T, { rail: "channel_actions", id: "44444444-4444-4444-8444-444444444444" });
  });

  it("H5: a card whose close fails is retried once, and the refusal says it was filed but can never be sent", async () => {
    const discard = vi.fn(async () => {
      throw new Error("db");
    });
    const p = propose(bound, { attachPlanned: async () => ({ ok: false, code: "plan_changed" }), discardPlanned: discard });
    await expect(p.run()).rejects.toMatchObject({ code: "email_plan_changed", message: expect.stringContaining("could not confirm") });
    expect(discard).toHaveBeenCalledTimes(2);
  });

  it("must catch J1: a discard the server answers false (nothing closed) is never reported as nothing proposed", async () => {
    const discard = vi.fn(async () => false);
    const p = propose(bound, { attachPlanned: async () => ({ ok: false, code: "plan_changed" }), discardPlanned: discard });
    const e = (await p.run().catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain("Nothing was proposed");
    expect(e.message).toContain("could not confirm");
  });

  it("must catch J1: an attach whose answer was lost is asked again and, being idempotent, links the card", async () => {
    let n = 0;
    const attach = vi.fn(async () => {
      if (++n === 1) throw new Error("connection reset");
      return { ok: true };
    });
    const p = propose(bound, { attachPlanned: attach });
    await expect(p.run()).resolves.toMatchObject({ planned: true });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(p.discard).not.toHaveBeenCalled();
  });

  it("refuses another list, a stale binding, a redraft and an unreadable run, before anything is filed", async () => {
    for (const [run, code, a] of [
      [{ ...bound, list_id: "other-list" }, "email_wrong_list", {}],
      [{ ...bound, stale: true }, "email_plan_changed", {}],
      [bound, "email_plan_no_replace", { replaces: { rail: "channel_actions", id: ITEM } }],
      [new Error("db"), "plan_unreadable", {}],
      [{ found: true, mode: "weekly_plan" }, "plan_run_plans_only", {}],
    ] as Array<[PlanRunContext | Error, string, Record<string, unknown>]>) {
      const p = propose(run);
      await expect(p.run(a)).rejects.toMatchObject({ code });
      expect(p.emit).not.toHaveBeenCalled();
    }
  });

  it("an ordinary run is unchanged: no item in the card, no attach", async () => {
    const p = propose({ found: true, mode: null });
    await p.run();
    expect((p.emit.mock.calls[0] as unknown[])[1]).not.toHaveProperty("planned_send_id");
    expect(p.attach).not.toHaveBeenCalled();
  });
});

describe("a chat redraft of a planned card keeps its plan", () => {
  const OLD = { rail: "channel_actions" as const, id: "55555555-5555-4555-8555-555555555555" };
  const NEW = "44444444-4444-4444-8444-444444444444";
  const WHOLE = ["subject", "preview_text", "title", "paragraphs", "button"];
  function redraft(found: Error | null | { item_id: string; version: number; status: string; open: boolean }, over: Partial<ProposeCampaignDeps> = {}) {
    const sg = fakeSendgrid();
    const emit = vi.fn(async () => NEW);
    const rebind = vi.fn(async () => ({ ok: true }));
    const attach = vi.fn(async () => ({ ok: true }));
    const replaceCard = vi.fn(async () => true);
    const discard = vi.fn(async () => true);
    const reserveCard = vi.fn(async () => ({ ok: true as const, id: "reservation-1" }));
    const tool = makeProposeCampaignTool({
      resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: sendgridKeyDigest(BRIGHTLOOP_KEY) } })) as never,
      callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
      template: async () => TEMPLATE,
      company: async () => ({ name: "Brightloop", website: "https://brightloop.test" }),
      testLists: async () => new Set<string>(),
      setting: async () => null,
      railOf: async () => "channel_actions",
      runContext: async () => ({ found: true, mode: null }),
      redraftPlan: async () => {
        if (found instanceof Error) throw found;
        return found;
      },
      rebindPlanned: rebind,
      attachPlanned: attach,
      replaceCard,
      discardPlanned: discard,
      reserveCard,
      releaseCard: async () => undefined,
      settleCard: async () => undefined,
      now: () => new Date("2026-10-20T12:00:00Z"),
      ...over,
    });
    const run = () => tool.execute(ctx({ emit_decision: emit }), { route: "sendgrid", audience_id: SG_LIST, variants: [version], replaces: OLD, changes: WHOLE } as never);
    return { run, emit, rebind, attach, replaceCard, discard, reserveCard };
  }
  const code = (e: unknown) => (e as { code?: string }).code;

  it("must catch: the new card is born bound, so Autopilot's door sees a planned card, and the item moves to it instead of the card being rejected", async () => {
    const p = redraft({ item_id: ITEM, version: 2, status: "ready", open: true });
    const out = (await p.run()) as Record<string, unknown>;
    expect((p.emit.mock.calls[0] as unknown[])[1]).toMatchObject({ planned_send_id: ITEM, plan_version: 2 });
    expect(isPlannedCard((p.emit.mock.calls[0] as unknown[])[1])).toBe(true);
    expect(p.rebind).toHaveBeenCalledWith(expect.anything(), { item_id: ITEM, version: 2, old: OLD, rail: "channel_actions", id: NEW });
    expect(p.replaceCard).not.toHaveBeenCalled();
    expect(p.attach).not.toHaveBeenCalled();
    expect(out).toMatchObject({ planned: true, replaced_previous: true });
    expect(String(out.note)).toContain("The previous draft is closed.");
    expect(String(out.note)).toContain("It is planned");
  });

  it.each(["skipped", "blocked"])("a %s item with its card still open keeps the link too", async (status) => {
    const p = redraft({ item_id: ITEM, version: 2, status, open: true });
    await p.run();
    expect(p.rebind).toHaveBeenCalledTimes(1);
    expect(p.replaceCard).not.toHaveBeenCalled();
  });

  it("must catch: an email approved for its time is refused before anything is reserved or filed, in words that name the way out", async () => {
    const p = redraft({ item_id: ITEM, version: 2, status: "scheduled", open: true });
    const e = await p.run().catch((x: unknown) => x);
    expect(code(e)).toBe("email_plan_scheduled");
    expect((e as Error).message).toContain("Don't send");
    expect(p.reserveCard).not.toHaveBeenCalled();
    expect(p.emit).not.toHaveBeenCalled();
    expect(p.replaceCard).not.toHaveBeenCalled();
  });

  it("an unreadable plan files nothing: a redraft can never land unbound because a read failed", async () => {
    const p = redraft(new Error("db down"));
    expect(code(await p.run().catch((x: unknown) => x))).toBe("plan_unreadable");
    expect(p.emit).not.toHaveBeenCalled();
    expect(p.replaceCard).not.toHaveBeenCalled();
  });

  it("the plan changes while the redraft runs: the new card is closed again and the old one stays", async () => {
    const p = redraft({ item_id: ITEM, version: 2, status: "ready", open: true }, { rebindPlanned: async () => ({ ok: false, code: "plan_changed" }) });
    expect(code(await p.run().catch((x: unknown) => x))).toBe("email_plan_changed");
    expect(p.discard).toHaveBeenCalledWith(expect.anything(), { rail: "channel_actions", id: NEW });
    expect(p.replaceCard).not.toHaveBeenCalled();
  });

  it("a redraft sent to a different list is refused the same way", async () => {
    const p = redraft({ item_id: ITEM, version: 2, status: "ready", open: true }, { rebindPlanned: async () => ({ ok: false, code: "wrong_list" }) });
    expect(code(await p.run().catch((x: unknown) => x))).toBe("email_wrong_list");
    expect(p.discard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unplanned card", null],
    ["a closed planned card", { item_id: ITEM, version: 2, status: "skipped", open: false }],
    ["a card already sending", { item_id: ITEM, version: 2, status: "sending", open: false }],
  ])("control: %s is an ordinary redraft", async (_name, found) => {
    const p = redraft(found);
    await p.run();
    expect((p.emit.mock.calls[0] as unknown[])[1]).not.toHaveProperty("planned_send_id");
    expect(p.rebind).not.toHaveBeenCalled();
    expect(p.replaceCard).toHaveBeenCalledTimes(1);
  });
});

describe("a move refused for being too close states the move's rule", () => {
  const close = { rpc: (async () => ({ ok: false, code: "too_soon" })) as never };
  it("says 1 hour, not the 26 hours that only binds a new plan", async () => {
    const out = await movePlanned(T, "u", ITEM, { date: "2026-11-20", time: "09:30", schedule_gen: 1, timezone: "UTC" }, close);
    expect(out).toMatchObject({ ok: false, code: "move_too_soon" });
    expect((out as { message: string }).message).toContain("1 hour");
    expect((out as { message: string }).message).not.toContain("26");
  });
  it("control: a new plan refused too_soon keeps the 26 hour sentence", () => {
    expect(planRefusal("too_soon")).toContain("26 hours");
  });
});

describe("the Zavi-list door (R9)", () => {
  const D = "66666666-6666-4666-8666-666666666666";
  it("goes only when the SQL check holds and the list is at most 1,000 people now", async () => {
    expect(await plannedListSendRefusal(T, D, { check: async () => ({ ok: true }), count: async () => 1000 })).toBeNull();
    expect(await plannedListSendRefusal(T, D, { check: async () => ({ ok: true }), count: async () => 1001 })).toMatchObject({ code: "planned_audience_over_limit" });
    expect(await plannedListSendRefusal(T, D, { check: async () => ({ ok: true }), count: async () => null })).toMatchObject({ code: "planned_check_failed" });
  });

  it("must catch: a list imported again after the draft aborts it, in words, with nobody emailed", async () => {
    expect(await plannedListSendRefusal(T, D, { check: async () => ({ ok: false, code: "list_version_changed" }), count: async () => 10 })).toEqual({
      code: "planned_list_version_changed",
      sentence: expect.stringContaining("imported again"),
    });
    expect(await plannedListSendRefusal(T, D, { check: async () => { throw new Error("db"); }, count: async () => 10 })).toMatchObject({ code: "planned_check_failed" });
  });
});
