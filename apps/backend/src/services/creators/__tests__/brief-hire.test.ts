
import { describe, expect, it } from "vitest";
import {
  hireApplicant,
  settleBriefHire,
  type BriefOrderPort,
  type HireDeps,
  type SettleHireDeps,
} from "../brief-hire";
import { computeCreatorFees } from "../order-fees";
import { creatorVisibleBrief } from "../brief-projection";
import type { AutoNoDeps, AutoNoResult } from "../brief-applications";
import type { BriefApplicationRow, TenantBriefRow } from "../briefs-db";
import type { CreatorOrderStateRow } from "../orders-db";

const TENANT = "11111111-1111-1111-1111-111111111111";
const BRIEF = "b1111111-1111-1111-1111-111111111111";
const APPLICATION = "a1111111-1111-1111-1111-111111111111";
const CREATOR = "c1111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const USER = "u1111111-1111-1111-1111-111111111111";

const T0 = "2026-09-11T00:00:00.000Z";
const D = 24 * 3_600_000;
const plus = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

function tenantBrief(over: Partial<TenantBriefRow> = {}): TenantBriefRow {
  return {
    id: BRIEF,
    tenant_id: TENANT,
    status: "sent",
    title: "3 ad videos for the spring push",
    angle: "Show the handover",
    hook: "I almost did not book this car",
    format: "9:16 UGC, 30 seconds",
    deliverables: 3,
    rationale: "CTR on ad set 9912 fell 41%",
    evidence: [{ ad_set: "9912" }],
    source_campaign_ref: "spring-retarget-2026",
    source_run_id: null,
    budget_usd: 450,
    utm_campaign: "zavi-brief-4f2a91bc77de",
    lane: "ugc_video",
    filters: null,
    delivery_days: 7,
    posted_at: T0,
    answer_by: plus(5 * D),
    applicant_cap: 20,
    decline_note: null,
    closed_at: null,
    created_at: T0,
    updated_at: null,
    ...over,
  };
}

function application(over: Partial<BriefApplicationRow> = {}): BriefApplicationRow {
  return {
    id: APPLICATION,
    tenant_id: TENANT,
    brief_id: BRIEF,
    brief_kind: "creative",
    human_member_id: CREATOR,
    status: "applied",
    pitch: "I shoot handovers in Austin",
    quoted_rate_usd: "150.00",
    created_at: plus(1),
    ...over,
  };
}

type Recorded = { call: string; args: Record<string, unknown> };

function hireWorld(over: Partial<HireDeps> = {}) {
  const calls: Recorded[] = [];
  let app = application();
  const port: BriefOrderPort = {
    startApplicantCheckout: async (a) => {
      calls.push({
        call: "startApplicantCheckout",
        args: a as unknown as Record<string, unknown>,
      });
      return {
        order_id: ORDER,
        checkout_session_id: "cs_test_1",
        checkout_url: "https://checkout.test/cs_test_1",
      };
    },
  };
  const deps: HireDeps = {
    loadBrief: async (_t, id) => (id === BRIEF ? tenantBrief() : null),
    loadApplication: async ({ application_id }) => (application_id === app.id ? { ...app } : null),
    claimApplication: async () => {
      if (app.status !== "applied" && app.status !== "shortlisted") return null;
      app = { ...app, status: "approved" };
      calls.push({ call: "claimApplication", args: {} });
      return { ...app };
    },
    releaseClaim: async () => {
      app = { ...app, status: "applied" };
      calls.push({ call: "releaseClaim", args: {} });
    },
    profiles: async () =>
      new Map([[CREATOR, { display_name: "Maya R", slug: "maya", city: "Austin", country_code: "US", bookable: true }]]),
    businessName: async () => "Northwind Coffee",
    orders: port,
    now: () => new Date(T0),
    log: (async () => {}) as HireDeps["log"],
    ...over,
  };
  return { deps, calls, port, application: () => ({ ...app }) };
}

const HIRE_ARGS = {
  tenant_id: TENANT,
  brief_id: BRIEF,
  application_id: APPLICATION,
  booked_by_user_id: USER,
  success_url: "https://app.test/ok",
  cancel_url: "https://app.test/no",
};

describe("hiring an applicant (spec item 34)", () => {
  it("claims the application, then goes through S7's ONE checkout entry point", async () => {
    const w = hireWorld();
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(true);
    expect(w.calls.map((c) => c.call)).toEqual(["claimApplication", "startApplicantCheckout"]);
    expect(w.calls.filter((c) => c.call === "startApplicantCheckout")).toHaveLength(1);
  });

  it("freezes the applicant's OWN price and the one fee rule onto the order", async () => {
    const w = hireWorld();
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok && res.fees).toEqual(computeCreatorFees(15_000));
    expect(res.ok && res.fees.business_total_cents).toBe(16_500);
    expect(res.ok && res.fees.creator_payout_cents).toBe(12_750);
  });

  it("freezes S9's shared brief projection, not a second hand-rolled shape", async () => {
    const w = hireWorld();
    await hireApplicant(HIRE_ARGS, w.deps);
    const sent = w.calls.find((c) => c.call === "startApplicantCheckout")?.args as {
      brief_snapshot: Record<string, unknown>;
    };
    expect(sent.brief_snapshot).toEqual(
      creatorVisibleBrief(tenantBrief(), {
        business_name: await w.deps.businessName(TENANT),
        applicant_count: 0,
        now: w.deps.now(),
      }) as unknown as Record<string, unknown>,
    );
  });

  it("passes the over-$500 confirm straight through to S7", async () => {
    const w = hireWorld();
    await hireApplicant({ ...HIRE_ARGS, large_amount_confirmed: true }, w.deps);
    const sent = w.calls.find((c) => c.call === "startApplicantCheckout")?.args as {
      large_amount_confirmed?: boolean;
    };
    expect(sent.large_amount_confirmed).toBe(true);
  });

  it("sets the due date from the brief's delivery days, counted from hire (Q23)", async () => {
    const w = hireWorld();
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok && res.due_at).toBe(plus(7 * D));
  });

  it("lets the founder adjust the due date before confirming", async () => {
    const w = hireWorld();
    const res = await hireApplicant({ ...HIRE_ARGS, delivery_days: 3 }, w.deps);
    expect(res.ok && res.due_at).toBe(plus(3 * D));
  });

  it("refuses a delivery window outside the schema's range", async () => {
    const w = hireWorld();
    const res = await hireApplicant({ ...HIRE_ARGS, delivery_days: 400 }, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("due_date_invalid");
    expect(w.calls).toHaveLength(0);
  });

  it("invariant 6: freezes the brief EXACTLY as the business last saved it", async () => {
    const w = hireWorld();
    await hireApplicant(HIRE_ARGS, w.deps);
    const created = w.calls.find((c) => c.call === "startApplicantCheckout")?.args as {
      brief_snapshot: Record<string, unknown>;
    };
    expect(created.brief_snapshot.title).toBe("3 ad videos for the spring push");
    expect(created.brief_snapshot.hook).toBe("I almost did not book this car");
    const payload = JSON.stringify(created.brief_snapshot);
    expect(payload).not.toContain("CTR on ad set");
    expect(payload).not.toContain("zavi-brief-");
    expect(payload).not.toContain("spring-retarget-2026");
  });

  it("refuses a second hire on the same application (the claim is the guard)", async () => {
    const w = hireWorld();
    const first = await hireApplicant(HIRE_ARGS, w.deps);
    const second = await hireApplicant(HIRE_ARGS, w.deps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("application_not_pending");
    expect(w.calls.filter((c) => c.call === "startApplicantCheckout")).toHaveLength(1);
  });

  it("hands the claim back when the order could not be created", async () => {
    const w = hireWorld();
    w.deps.orders = {
      startApplicantCheckout: async () => {
        throw new Error("insert blew up");
      },
    };
    await expect(hireApplicant(HIRE_ARGS, w.deps)).rejects.toThrow("insert blew up");
    expect(w.application().status).toBe("applied");
    expect(w.calls.map((c) => c.call)).toContain("releaseClaim");
  });

  it("invariant 7: refuses a creator Zavi cannot pay, before taking a card", async () => {
    const w = hireWorld({
      profiles: async () =>
        new Map([[CREATOR, { display_name: "Tolu A", slug: "tolu", city: "Lagos", country_code: "NG", bookable: false }]]),
    });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("payout_country_unsupported");
      expect(res.message).toContain("Nothing was charged");
    }
    expect(w.calls).toHaveLength(0);
  });

  it("refuses an applicant who left no price", async () => {
    const w = hireWorld({ loadApplication: async () => application({ quoted_rate_usd: null }) });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("no_quote");
    expect(w.calls).toHaveLength(0);
  });

  it("404s an application that belongs to a different brief, with one code", async () => {
    const w = hireWorld({
      loadApplication: async () => application({ brief_id: "b9999999-9999-9999-9999-999999999999" }),
    });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("application_not_found");
      expect(res.message).toBe("That application is not on this brief.");
    }
  });

  it("refuses a hire on a brief that was never posted", async () => {
    const w = hireWorld({ loadBrief: async () => tenantBrief({ posted_at: null }) });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brief_not_posted");
  });

  it("refuses a hire on a brief that is already closed, so nobody is charged twice for one brief", async () => {
    const w = hireWorld({ loadBrief: async () => tenantBrief({ posted_at: T0, closed_at: T0 }) });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: false, code: "brief_closed" });
  });
});

function orderRow(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "applicant",
    status: "in_progress",
    closed_reason: null,
    created_at: T0,
    due_at: plus(7 * D),
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: plus(7 * D),
    next_deadline_kind: "due",
    responded_at: T0,
    accepted_at: T0,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: { title: "3 ad videos for the spring push" },
    livemode: false,
    ...over,
  };
}

function settleWorld(over: Partial<SettleHireDeps> = {}) {
  const transitions: string[] = [];
  const autoNoCalls: { cause: string; hired: string | null | undefined }[] = [];
  const noResult: AutoNoResult = { declined: 3, notified: 3, closed_by_this_call: true, note: "note" };
  const deps: SettleHireDeps = {
    transition: (async (a: { trigger: string }) => {
      transitions.push(a.trigger);
      return {
        ok: true as const,
        order: orderRow(),
        trigger: "hire_applicant" as const,
        from: "checkout_pending" as const,
        to: "in_progress" as const,
        deadline: null,
        money: [{ effect: { kind: "capture", cause: "hire" }, result: { ok: true } }],
        needs_staff_review: false,
        payout_waiting: false,
      };
    }) as SettleHireDeps["transition"],
    autoNo: (async (a: { cause: string; hired_application_id?: string | null }) => {
      autoNoCalls.push({ cause: a.cause, hired: a.hired_application_id });
      return noResult;
    }) as SettleHireDeps["autoNo"],
    autoNoDeps: {} as AutoNoDeps,
    loadOrder: (async () => ({
      id: ORDER,
      source: "applicant",
      status: "checkout_pending",
      brief_id: BRIEF,
      application_id: APPLICATION,
      stripe_payment_intent_id: "pi_hire",
    })) as unknown as SettleHireDeps["loadOrder"],
    claimBrief: (async () => "claimed") as SettleHireDeps["claimBrief"],
    releaseBrief: (async () => {}) as SettleHireDeps["releaseBrief"],
    readHold: (async () => ({ refunded_cents: 0 })) as unknown as SettleHireDeps["readHold"],
    log: (async () => {}) as SettleHireDeps["log"],
    ...over,
  };
  return { deps, transitions, autoNoCalls };
}

const SETTLE_ARGS = {
  tenant_id: TENANT,
  order_id: ORDER,
  brief_id: BRIEF,
  application_id: APPLICATION,
  actor_user_id: USER,
};

describe("settle takes the same one-capture-per-brief claim as fulfilment", () => {
  it("A claimed and captured via fulfil: settle for B never captures", async () => {
    const w = settleWorld({
      claimBrief: (async () => "taken") as SettleHireDeps["claimBrief"],
      loadOrder: (async () => ({
        id: "order-b",
        source: "applicant",
        status: "checkout_pending",
        brief_id: BRIEF,
        application_id: "app-b",
      })) as unknown as SettleHireDeps["loadOrder"],
    });
    const res = await settleBriefHire({ ...SETTLE_ARGS, order_id: "order-b", application_id: "app-b" }, w.deps);
    expect(res).toMatchObject({ ok: false, code: "brief_filled" });
    expect(w.transitions).toEqual([]);
    expect(w.autoNoCalls).toEqual([]);
  });

  it("a retry of settle for a cancelled order never re-claims the brief", async () => {
    const claims: string[] = [];
    const released: string[] = [];
    const w = settleWorld({
      loadOrder: (async () => ({
        id: ORDER,
        source: "applicant",
        status: "cancelled",
        closed_reason: "payment_failed",
        brief_id: BRIEF,
        application_id: APPLICATION,
      })) as unknown as SettleHireDeps["loadOrder"],
      claimBrief: (async (a: { order_id: string }) => {
        claims.push(a.order_id);
        return "claimed";
      }) as SettleHireDeps["claimBrief"],
      releaseBrief: (async (a: { order_id: string }) => {
        released.push(a.order_id);
      }) as SettleHireDeps["releaseBrief"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: false, code: "order_cancelled" });
    expect(claims).toEqual([]);
    expect(released).toEqual([ORDER]);
    expect(w.transitions).toEqual([]);
  });

  it("an order that is not this brief's applicant hire never claims the brief", async () => {
    for (const o of [null, { id: ORDER, source: "booking", status: "in_progress" }, { id: ORDER, source: "applicant", status: "checkout_pending", brief_id: "other", application_id: APPLICATION }]) {
      const claims: string[] = [];
      const w = settleWorld({
        loadOrder: (async () => o) as unknown as SettleHireDeps["loadOrder"],
        claimBrief: (async (a: { order_id: string }) => {
          claims.push(a.order_id);
          return "claimed";
        }) as SettleHireDeps["claimBrief"],
      });
      const res = await settleBriefHire(SETTLE_ARGS, w.deps);
      expect(res).toMatchObject({ ok: false, code: "not_this_hire" });
      expect(claims).toEqual([]);
      expect(w.transitions).toEqual([]);
    }
  });

  it("a refusal after this call claimed gives the claim back", async () => {
    const released: string[] = [];
    const w = settleWorld({
      transition: (async () => ({ ok: false as const, code: "order_not_found" as const, message: "no" })) as SettleHireDeps["transition"],
      releaseBrief: (async (a: { order_id: string }) => {
        released.push(a.order_id);
      }) as SettleHireDeps["releaseBrief"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    expect(released).toEqual([ORDER]);
  });

  it("a lost capture reply completes the hire on one more run: job started, nos sent, claim kept", async () => {
    const released: string[] = [];
    let calls = 0;
    const w = settleWorld({
      transition: (async () => {
        calls += 1;
        if (calls === 1) return { ok: false as const, code: "money_needs_staff" as const, message: "check Stripe" };
        return {
          ok: true as const,
          order: orderRow(),
          trigger: "hire_applicant" as const,
          from: "checkout_pending" as const,
          to: "in_progress" as const,
          deadline: null,
          money: [{ effect: { kind: "capture", cause: "hire" }, result: { ok: true, already_captured: true } }],
          needs_staff_review: false,
          payout_waiting: false,
        };
      }) as SettleHireDeps["transition"],
      releaseBrief: (async (a: { order_id: string }) => {
        released.push(a.order_id);
      }) as SettleHireDeps["releaseBrief"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: true, charged: true });
    expect(calls).toBe(2);
    expect(w.autoNoCalls).toEqual([{ cause: "hire", hired: APPLICATION }]);
    expect(released).toEqual([]);
  });

  it("a lost capture that was refunded is not completed on retry", async () => {
    let calls = 0;
    const w = settleWorld({
      transition: (async () => {
        calls += 1;
        return { ok: false as const, code: "money_needs_staff" as const, message: "check Stripe" };
      }) as SettleHireDeps["transition"],
      readHold: (async () => ({ refunded_cents: 16_500 })) as unknown as SettleHireDeps["readHold"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: false, code: "money_needs_staff" });
    expect(calls).toBe(1);
    expect(w.autoNoCalls).toEqual([]);
  });

  it("an unknown money outcome keeps the claim, so a second card is never captured behind it", async () => {
    const released: string[] = [];
    const w = settleWorld({
      transition: (async () => ({ ok: false as const, code: "money_needs_staff" as const, message: "check Stripe" })) as SettleHireDeps["transition"],
      releaseBrief: (async (a: { order_id: string }) => {
        released.push(a.order_id);
      }) as SettleHireDeps["releaseBrief"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: false, code: "money_needs_staff" });
    expect(released).toEqual([]);
  });

  it("a failed capture gives the claim back", async () => {
    const released: string[] = [];
    const w = settleWorld({
      releaseBrief: (async (a: { order_id: string }) => {
        released.push(a.order_id);
      }) as SettleHireDeps["releaseBrief"],
      transition: (async () => ({
        ok: true as const,
        order: orderRow({ status: "cancelled", closed_reason: "payment_failed" }),
        trigger: "hire_applicant" as const,
        from: "checkout_pending" as const,
        to: "cancelled" as const,
        deadline: null,
        money: [],
        needs_staff_review: false,
        payout_waiting: false,
      })) as SettleHireDeps["transition"],
    });
    await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(released).toEqual([ORDER]);
  });
});

describe("the charge goes through S3 and nothing else", () => {
  it("charges with exactly ONE `hire_applicant` transition", async () => {
    const w = settleWorld();
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res.ok && res.charged).toBe(true);
    expect(w.transitions).toEqual(["hire_applicant"]);
  });

  it("sends the automatic nos at hire, excluding the person hired", async () => {
    const w = settleWorld();
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(w.autoNoCalls).toEqual([{ cause: "hire", hired: APPLICATION }]);
    expect(res.ok && res.automatic_nos?.declined).toBe(3);
  });

  it("T1: a failed capture sends NO nos, because nobody was hired", async () => {
    const w = settleWorld({
      transition: (async () => ({
        ok: true as const,
        order: orderRow({ status: "cancelled", closed_reason: "payment_failed" }),
        trigger: "hire_applicant" as const,
        from: "checkout_pending" as const,
        to: "cancelled" as const,
        deadline: null,
        money: [],
        needs_staff_review: false,
        payout_waiting: false,
      })) as SettleHireDeps["transition"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res.ok && res.charged).toBe(false);
    expect(res.ok && res.automatic_nos).toBeNull();
    expect(w.autoNoCalls).toHaveLength(0);
  });

  it("a replay of a hire that already charged still closes the brief and sends the nos", async () => {
    const w = settleWorld({
      transition: (async () => ({
        ok: false as const,
        code: "illegal_transition" as const,
        message: "already hired",
      })) as SettleHireDeps["transition"],
      loadOrder: (async () => ({
        id: ORDER,
        source: "applicant",
        status: "in_progress",
        brief_id: BRIEF,
        application_id: APPLICATION,
      })) as unknown as SettleHireDeps["loadOrder"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res).toMatchObject({ ok: true, charged: true });
    expect(w.autoNoCalls).toEqual([{ cause: "hire", hired: APPLICATION }]);
  });

  it("a replay never sends nos for an order that is not this brief's charged hire", async () => {
    for (const o of [
      { status: "cancelled", brief_id: BRIEF, application_id: APPLICATION },
      { status: "in_progress", brief_id: BRIEF, application_id: "other-app" },
      { status: "in_progress", brief_id: "other-brief", application_id: APPLICATION },
    ]) {
      const w = settleWorld({
        transition: (async () => ({
          ok: false as const,
          code: "illegal_transition" as const,
          message: "no",
        })) as SettleHireDeps["transition"],
        loadOrder: (async () => ({ id: ORDER, source: "applicant", ...o })) as unknown as SettleHireDeps["loadOrder"],
      });
      const res = await settleBriefHire(SETTLE_ARGS, w.deps);
      expect(res.ok).toBe(false);
      expect(w.autoNoCalls).toHaveLength(0);
    }
  });

  it("a replayed settle reports the conflict and does not re-run the nos", async () => {
    const w = settleWorld({
      transition: (async () => ({
        ok: false as const,
        code: "illegal_transition" as const,
        message: "already hired",
      })) as SettleHireDeps["transition"],
    });
    const res = await settleBriefHire(SETTLE_ARGS, w.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("illegal_transition");
    expect(w.autoNoCalls).toHaveLength(0);
  });
});

describe("hiring from a brief that filled its applicant cap", () => {
  it("the founder can still hire one of the applicants the cap let in", async () => {
    const { applyToBrief } = await import("../brief-applications");
    let row = tenantBrief({ applicant_cap: 2 });
    const apps: BriefApplicationRow[] = [];
    const members: Record<string, { id: string; display_name: string; vetting_state: string; lanes: string[]; country_code: string }> = {
      ua: { id: CREATOR, display_name: "Maya R", vetting_state: "approved", lanes: ["ugc_video"], country_code: "US" },
      ub: { id: "c2222222-2222-2222-2222-222222222222", display_name: "Tolu A", vetting_state: "approved", lanes: ["ugc_video"], country_code: "US" },
    };
    for (const [auth, rate] of [["ua", 150], ["ub", 220]] as const) {
      const r = await applyToBrief(
        { auth_user_id: auth, brief_id: BRIEF, quoted_rate_usd: rate, now: new Date(plus(D)) },
        {
          loadMember: async (u) => members[u] ?? null,
          loadBrief: async () => ({ ...row }),
          resolveTenant: async () => ({ tenant_id: TENANT, status: row.status }),
          count: async () => apps.length,
          insert: async (a) => {
            const id = apps.length === 0 ? APPLICATION : `a${apps.length + 1}`;
            apps.push(application({ id, human_member_id: a.human_member_id, quoted_rate_usd: a.quoted_rate_usd, status: "applied" }));
            return { ok: true, application_id: id };
          },
          businessName: async () => "Northwind Coffee",
          closeBrief: (async (a: { closed_at: string; status?: string }) => {
            if (row.closed_at) return null;
            row = { ...row, closed_at: a.closed_at, ...(a.status ? { status: a.status } : {}) };
            return { ...row };
          }) as never,
          notify: (async () => ({ written: true, emailed: true })) as never,
        },
      );
      expect(r.ok).toBe(true);
    }

    const w = hireWorld({
      loadBrief: async (_t, id) => (id === BRIEF ? { ...row } : null),
      now: () => new Date(plus(2 * D)),
    });
    const res = await hireApplicant(HIRE_ARGS, w.deps);
    expect(res.ok).toBe(true);
    expect(res.ok && res.checkout_url).toBe("https://checkout.test/cs_test_1");
    expect(w.calls.map((c) => c.call)).toEqual(["claimApplication", "startApplicantCheckout"]);
  });
});
