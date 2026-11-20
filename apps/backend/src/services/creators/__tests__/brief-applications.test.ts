
import { describe, expect, it } from "vitest";
import {
  MAX_APPLICATION_NOTE_LEN,
  applyToBrief,
  creatorBoard,
  sendAutomaticNos,
  type ApplyDeps,
  type AutoNoDeps,
  type BoardDeps,
} from "../brief-applications";
import { DEFAULT_DECLINE_NOTE, MIN_QUOTE_CENTS, quoteFeeSplit } from "../briefs";
import { MIN_BUSINESS_TOTAL_CENTS, computeCreatorFees } from "../order-fees";
import type { BriefApplicationRow, TenantBriefRow } from "../briefs-db";
import type { CreatorBriefSourceRow } from "../brief-projection";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const BRIEF = "b1111111-1111-1111-1111-111111111111";
const AUTH_A = "u1111111-1111-1111-1111-111111111111";
const AUTH_B = "u2222222-2222-2222-2222-222222222222";
const CREATOR_A = "c1111111-1111-1111-1111-111111111111";
const CREATOR_B = "c2222222-2222-2222-2222-222222222222";
const AUTH_C = "u3333333-3333-3333-3333-333333333333";
const CREATOR_C = "c3333333-3333-3333-3333-333333333333";

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
    evidence: [],
    source_campaign_ref: "spring-retarget-2026",
    source_run_id: null,
    budget_usd: 450,
    utm_campaign: "zavi-brief-4f2a91bc77de",
    lane: "ugc_video",
    filters: null,
    delivery_days: 7,
    posted_at: T0,
    answer_by: plus(5 * D),
    applicant_cap: 2,
    decline_note: null,
    closed_at: null,
    created_at: T0,
    updated_at: null,
    ...over,
  };
}

function boardRow(b: TenantBriefRow): CreatorBriefSourceRow {
  return {
    id: b.id,
    title: b.title,
    angle: b.angle,
    hook: b.hook,
    format: b.format,
    deliverables: b.deliverables,
    budget_usd: b.budget_usd,
    lane: b.lane,
    delivery_days: b.delivery_days,
    posted_at: b.posted_at,
    answer_by: b.answer_by,
    applicant_cap: b.applicant_cap,
    closed_at: b.closed_at,
  };
}

type Member = {
  id: string;
  display_name: string;
  vetting_state: string;
  lanes: string[] | null;
  country_code: string | null;
};

const MEMBERS: Record<string, Member> = {
  [AUTH_A]: {
    id: CREATOR_A,
    display_name: "Maya R",
    vetting_state: "approved",
    lanes: ["ugc_video"],
    country_code: "US",
  },
  [AUTH_B]: {
    id: CREATOR_B,
    display_name: "Tolu A",
    vetting_state: "approved",
    lanes: ["ugc_video"],
    country_code: "US",
  },
  [AUTH_C]: {
    id: CREATOR_C,
    display_name: "Ana P",
    vetting_state: "approved",
    lanes: ["ugc_video"],
    country_code: "US",
  },
};

function world(initial: TenantBriefRow = tenantBrief()) {
  let brief = { ...initial };
  const applications: BriefApplicationRow[] = [];
  const notices: { event: string; to: string; scope?: string | null; note?: string | null }[] = [];
  let nextId = 1;

  const apply: ApplyDeps = {
    loadMember: async (auth_user_id) => MEMBERS[auth_user_id] ?? null,
    loadBrief: async (id) => (id === brief.id && brief.posted_at ? boardRow(brief) : null),
    resolveTenant: async (id) => (id === brief.id ? { tenant_id: brief.tenant_id, status: brief.status } : null),
    count: async () => applications.length,
    insert: async (a) => {
      if (applications.some((x) => x.human_member_id === a.human_member_id && x.brief_id === a.brief_id)) {
        return { ok: false, duplicate: true };
      }
      const id = `a${nextId++}`;
      applications.push({
        id,
        tenant_id: a.tenant_id,
        brief_id: a.brief_id,
        brief_kind: "creative",
        human_member_id: a.human_member_id,
        status: "applied",
        pitch: a.pitch,
        quoted_rate_usd: a.quoted_rate_usd,
        created_at: plus(nextId),
      });
      return { ok: true, application_id: id };
    },
    businessName: async () => "Northwind Coffee",
    closeBrief: async ({ closed_at, status }) => {
      if (brief.closed_at) return null;
      brief = { ...brief, closed_at, ...(status ? { status } : {}) };
      return { ...brief };
    },
    notify: (async (input: {
      recipient: { kind: string };
      event: string;
      scope_id?: string | null;
      vars?: { note?: string | null };
    }) => {
      notices.push({
        event: input.event,
        to: input.recipient.kind,
        scope: input.scope_id ?? null,
        note: input.vars?.note ?? null,
      });
      return { written: true, emailed: true, notification_id: "n1", dedupe_key: "k" };
    }) as ApplyDeps["notify"],
  };

  const autoNo: AutoNoDeps = {
    loadBrief: async (_t, id) => (id === brief.id ? { ...brief } : null),
    closeBrief: apply.closeBrief!,
    claim: async ({ except_application_id }) => {
      const moved: BriefApplicationRow[] = [];
      for (const a of applications) {
        if (a.id === except_application_id) continue;
        if (a.status !== "applied" && a.status !== "shortlisted") continue;
        a.status = "rejected";
        moved.push({ ...a });
      }
      return moved;
    },
    businessName: async () => "Northwind Coffee",
    notify: apply.notify as AutoNoDeps["notify"],
    liveBookings: async () => [],
    relinkBooking: async () => null,
  };

  return { apply, autoNo, applications, notices, brief: () => ({ ...brief }), setBrief: (b: Partial<TenantBriefRow>) => {
    brief = { ...brief, ...b };
  } };
}

describe("applying with your own price (spec item 14)", () => {
  it("records the creator's own quote and shows them the 15% split", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, note: "I shoot handovers", now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fees).toEqual(computeCreatorFees(15_000));
    expect(res.fees.creator_payout_cents).toBe(12_750);
    expect(res.fees.business_total_cents).toBe(16_500);
    expect(w.applications[0]?.quoted_rate_usd).toBe(150);
    expect(w.applications[0]?.pitch).toBe("I shoot handovers");
  });

  it("stores the pitch with contact details removed, so the business never receives them", async () => {
    const w = world();
    const res = await applyToBrief(
      {
        auth_user_id: AUTH_A,
        brief_id: BRIEF,
        quoted_rate_usd: 150,
        note: "  Call 512-555-0199, mail maya.r@gmail.com or book calendly.com/maya-r. I shoot handovers  ",
        now: new Date(T0),
      },
      w.apply,
    );
    expect(res.ok).toBe(true);
    const pitch = w.applications[0]?.pitch ?? "";
    for (const raw of ["0199", "gmail", "calendly"]) expect(pitch).not.toContain(raw);
    expect(pitch).toContain("[contact removed, keep it on Zavi]");
    expect(pitch.endsWith("I shoot handovers")).toBe(true);
    expect(JSON.stringify(w.notices)).not.toContain("gmail");
  });

  it("keeps a scrubbed pitch inside the note limit", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, note: "a@b.co ".repeat(1000), now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(true);
    expect((w.applications[0]?.pitch ?? "").length).toBeLessThanOrEqual(MAX_APPLICATION_NOTE_LEN);
    expect(w.applications[0]?.pitch).not.toContain("a@b.co");
  });

  it("tells the business with the application event, not the booking one", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(true);
    const events = w.notices.filter((n) => n.to === "tenant").map((n) => n.event);
    expect(events).toEqual(["brief_application_received"]);
    expect(w.notices.some((n) => n.event === "booking_request_received")).toBe(false);
  });

  it("tells the applicant how many places are left and when they hear back", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok && res.spots_line).toContain("1 place left");
    expect(res.ok && res.answer_by_line).toContain("hears back by");
  });

  it("never hands the applicant the agent's rationale or the attribution tag", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      w.apply,
    );
    const payload = JSON.stringify(res);
    expect(payload).not.toContain("CTR on ad set");
    expect(payload).not.toContain("zavi-brief-");
    expect(payload).not.toContain("spring-retarget-2026");
  });

  it("refuses a quote that is not a positive dollar amount, before any write", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 0, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_quote");
    expect(w.applications).toHaveLength(0);
  });
});

describe("a creator applies only in the lanes they offer", () => {
  function asMember(lanes: string[] | null): ApplyDeps["loadMember"] {
    return async () => ({ ...MEMBERS[AUTH_A], lanes });
  }

  it("refuses a creator left with only the retired audience post lane on an ad video brief, before any write or notice", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      { ...w.apply, loadMember: asMember(["audience_post"]) },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("lane_mismatch");
      expect(res.message).toContain("ad videos");
      expect(res.message).not.toMatch(/ugc_video|audience_post|\u2014|\u2013|--/);
    }
    expect(w.applications).toHaveLength(0);
    expect(w.notices).toHaveLength(0);
  });

  it("reads a brief with no lane recorded as an ad video brief", async () => {
    const w = world(tenantBrief({ lane: null }));
    const refused = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      { ...w.apply, loadMember: asMember(["audience_post"]) },
    );
    expect(!refused.ok && refused.code).toBe("lane_mismatch");
    expect(w.applications).toHaveLength(0);

    const taken = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      { ...w.apply, loadMember: asMember(["ugc_video"]) },
    );
    expect(taken.ok).toBe(true);
    expect(w.applications).toHaveLength(1);
  });

  it("lets a creator with no lanes recorded apply anywhere, as the board shows them every lane", async () => {
    for (const lanes of [[], null]) {
      const w = world();
      const res = await applyToBrief(
        { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
        { ...w.apply, loadMember: asMember(lanes) },
      );
      expect(res.ok).toBe(true);
    }
  });
});

describe("a quote has to be big enough for Stripe to charge", () => {
  it("refuses a ten cent quote at apply with its own code, before any write", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 0.1, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("quote_below_minimum");
      expect(res.message).toContain("$0.50");
      expect(res.message).toContain(`$${(MIN_QUOTE_CENTS / 100).toFixed(2)}`);
      expect(res.message).not.toMatch(/\u2014|\u2013|--/);
    }
    expect(w.applications).toHaveLength(0);
    expect(w.notices).toHaveLength(0);
  });

  it("puts the line exactly where the business total reaches fifty cents", async () => {
    expect(MIN_BUSINESS_TOTAL_CENTS).toBe(50);
    expect(quoteFeeSplit(MIN_QUOTE_CENTS / 100).business_total_cents).toBeGreaterThanOrEqual(50);
    expect(quoteFeeSplit((MIN_QUOTE_CENTS - 1) / 100).business_total_cents).toBeLessThan(50);

    const below = world();
    const refused = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: (MIN_QUOTE_CENTS - 1) / 100, now: new Date(T0) },
      below.apply,
    );
    expect(!refused.ok && refused.code).toBe("quote_below_minimum");
    expect(below.applications).toHaveLength(0);

    const at = world();
    const taken = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: String(MIN_QUOTE_CENTS / 100), now: new Date(T0) },
      at.apply,
    );
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.fees.business_total_cents).toBeGreaterThanOrEqual(50);
    expect(at.applications[0]?.quoted_rate_usd).toBe(MIN_QUOTE_CENTS / 100);
  });
});

describe("one application per creator per brief", () => {
  it("refuses the second apply by the same creator", async () => {
    const w = world();
    const first = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      w.apply,
    );
    const second = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 200, now: new Date(T0) },
      w.apply,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("already_applied");
      expect(second.message).toContain("One application per brief");
    }
    expect(w.applications).toHaveLength(1);
    expect(w.applications[0]?.quoted_rate_usd).toBe(150);
  });

  it("lets a DIFFERENT creator apply to the same brief", async () => {
    const w = world();
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, w.apply);
    const second = await applyToBrief(
      { auth_user_id: AUTH_B, brief_id: BRIEF, quoted_rate_usd: 220, now: new Date(T0) },
      w.apply,
    );
    expect(second.ok).toBe(true);
    expect(w.applications).toHaveLength(2);
  });
});

describe("the application cap (spec item 16)", () => {
  it("reaching the cap leaves the brief hireable: closed_at stays null and the board stops offering it", async () => {
    const w = world(tenantBrief({ applicant_cap: 2 }));
    const closes: unknown[] = [];
    const deps: ApplyDeps = {
      ...w.apply,
      closeBrief: async (a) => {
        closes.push(a);
        return w.apply.closeBrief!(a);
      },
    };
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, deps);
    const full = await applyToBrief({ auth_user_id: AUTH_B, brief_id: BRIEF, quoted_rate_usd: 220, now: new Date(T0) }, deps);
    expect(full.ok).toBe(true);
    expect(full.ok && full.brief.open).toBe(false);
    expect(full.ok && full.brief.closed_reason).toBe("cap_reached");
    expect(closes).toEqual([]);
    expect(w.brief().closed_at).toBeNull();

    const third = await applyToBrief(
      { auth_user_id: AUTH_C, brief_id: BRIEF, quoted_rate_usd: 90, now: new Date(T0) },
      deps,
    );
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("cap_reached");
    expect(w.applications).toHaveLength(2);

    const board = await creatorBoard(
      { member: { lanes: ["ugc_video"] }, now: new Date(T0) },
      {
        listBriefs: async () => [boardRow(w.brief())],
        counts: async (ids) => new Map(ids.map((id) => [id, w.applications.length])),
        businessNames: async (ids) => new Map(ids.map((id) => [id, "Northwind Coffee"])),
      },
    );
    expect(board.briefs).toEqual([]);
    expect(board.count_line).toContain("real zero");
  });

  it("a full brief moves to the applicant's own history instead of vanishing, and stays off everyone else's board", async () => {
    const w = world(tenantBrief({ applicant_cap: 1 }));
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, w.apply);
    const other = boardRow(tenantBrief({ id: "b3333333-3333-3333-3333-333333333333", title: "Still open", applicant_cap: 5 }));
    const deps: BoardDeps = {
      listBriefs: async () => [boardRow(w.brief()), other],
      counts: async (ids) => new Map(ids.map((id) => [id, id === BRIEF ? w.applications.length : 0])),
      businessNames: async (ids) => new Map(ids.map((id) => [id, "Northwind Coffee"])),
      appliedClosed: async () => [],
      appliedBriefIds: async (member) => (member === CREATOR_A ? [BRIEF] : []),
    };
    const mine = await creatorBoard({ member: { lanes: ["ugc_video"], id: CREATOR_A }, now: new Date(T0) }, deps);
    expect(mine.briefs.map((b) => b.id)).toEqual([other.id]);
    expect(mine.applied_closed.map((b) => b.id)).toEqual([BRIEF]);
    expect(mine.applied_closed[0]?.closed_reason).toBe("cap_reached");
    expect(mine.count_line).toBe("1 brief is open right now.");

    const theirs = await creatorBoard({ member: { lanes: ["ugc_video"], id: CREATOR_B }, now: new Date(T0) }, deps);
    expect(theirs.briefs.map((b) => b.id)).toEqual([other.id]);
    expect(theirs.applied_closed).toEqual([]);
  });

  it("a brief past its answer-by date drops off the board before the timer writes closed_at", async () => {
    const w = world();
    const board = await creatorBoard(
      { member: { lanes: ["ugc_video"] }, now: new Date(plus(5 * D + 1)) },
      {
        listBriefs: async () => [boardRow(w.brief())],
        counts: async (ids) => new Map(ids.map((id) => [id, 0])),
        businessNames: async (ids) => new Map(ids.map((id) => [id, "Northwind Coffee"])),
      },
    );
    expect(board.briefs).toEqual([]);
  });

  it("refuses an application once the cap is full", async () => {
    const w = world(tenantBrief({ applicant_cap: 1 }));
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, w.apply);
    const res = await applyToBrief(
      { auth_user_id: AUTH_B, brief_id: BRIEF, quoted_rate_usd: 220, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("cap_reached");
      expect(res.message).toContain("all the applications");
    }
    expect(w.applications).toHaveLength(1);
  });

  it("takes applications without limit when there is no cap", async () => {
    const w = world(tenantBrief({ applicant_cap: null }));
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, w.apply);
    const res = await applyToBrief(
      { auth_user_id: AUTH_B, brief_id: BRIEF, quoted_rate_usd: 220, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(true);
    expect(w.brief().closed_at).toBeNull();
  });
});

describe("a closed brief", () => {
  it("refuses an application on a brief that was filled", async () => {
    const w = world(tenantBrief({ closed_at: plus(1) }));
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(plus(2)) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brief_closed");
    expect(w.applications).toHaveLength(0);
  });

  it("refuses an application after the answer-by date and says which it was", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(plus(5 * D + 1)) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("brief_closed");
      expect(res.message).toContain("answer-by date passed");
    }
  });

  it("refuses an application to a brief that was never posted", async () => {
    const w = world(tenantBrief({ posted_at: null }));
    const res = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brief_not_found");
  });
});

describe("who may apply", () => {
  it("refuses somebody who is not a creator at all", async () => {
    const w = world();
    const res = await applyToBrief(
      { auth_user_id: "u-not-a-creator", brief_id: BRIEF, quoted_rate_usd: 150 },
      w.apply,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_a_creator");
  });

  it("refuses a creator still in vetting, without saying where they are in it", async () => {
    const w = world();
    const deps: ApplyDeps = {
      ...w.apply,
      loadMember: async () => ({ ...MEMBERS[AUTH_A], vetting_state: "under_review" }),
    };
    const res = await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150 }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("not_approved");
      expect(res.message).not.toContain("under_review");
    }
  });

  it("invariant 7: refuses a creator Zavi cannot pay, honestly and at apply time", async () => {
    const w = world();
    const deps: ApplyDeps = {
      ...w.apply,
      loadMember: async () => ({ ...MEMBERS[AUTH_A], country_code: "NG" }),
    };
    const res = await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150 }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("payout_country_unsupported");
      expect(res.message).toContain("cannot pay creators in your country");
      expect(res.message).not.toMatch(/[–—]|--/);
    }
    expect(w.applications).toHaveLength(0);
  });

  it("an affiliate-only creator (approved without a package) cannot apply; jobs and both can", async () => {
    const w = world();
    const refused = await applyToBrief(
      { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
      { ...w.apply, loadMember: async () => ({ ...MEMBERS[AUTH_A], earn_mode: "affiliate" }) },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("affiliate_only");
    expect(w.applications).toHaveLength(0);

    for (const earn_mode of ["both", "jobs", null]) {
      const w2 = world();
      const res = await applyToBrief(
        { auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) },
        { ...w2.apply, loadMember: async () => ({ ...MEMBERS[AUTH_A], earn_mode }) },
      );
      expect(res.ok, String(earn_mode)).toBe(true);
    }
  });
});

describe("the automatic no (spec item 16)", () => {
  async function twoApplicants() {
    const w = world(tenantBrief({ applicant_cap: 20 }));
    await applyToBrief({ auth_user_id: AUTH_A, brief_id: BRIEF, quoted_rate_usd: 150, now: new Date(T0) }, w.apply);
    await applyToBrief({ auth_user_id: AUTH_B, brief_id: BRIEF, quoted_rate_usd: 220, now: new Date(T0) }, w.apply);
    w.notices.length = 0;
    return w;
  }

  it("tells everyone who was not hired, exactly once, and closes the brief", async () => {
    const w = await twoApplicants();
    const res = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "hire", hired_application_id: "a1", now: new Date(plus(D)) },
      w.autoNo,
    );
    expect(res.declined).toBe(1);
    expect(res.notified).toBe(1);
    expect(res.closed_by_this_call).toBe(true);
    expect(w.brief().closed_at).toBe(plus(D));
    expect(w.brief().status).toBe("filled");
    expect(w.applications.find((a) => a.id === "a1")?.status).toBe("applied");
    expect(w.applications.find((a) => a.id === "a2")?.status).toBe("rejected");
    expect(w.notices).toEqual([
      { event: "not_hired", to: "creator", scope: "a2", note: DEFAULT_DECLINE_NOTE },
    ]);
  });

  it("IDEMPOTENT ON REPLAY: a second run declines nobody and sends nothing", async () => {
    const w = await twoApplicants();
    const first = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D)) },
      w.autoNo,
    );
    const second = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D + 60_000)) },
      w.autoNo,
    );
    expect(first.declined).toBe(2);
    expect(first.closed_by_this_call).toBe(true);
    expect(second.declined).toBe(0);
    expect(second.notified).toBe(0);
    expect(second.closed_by_this_call).toBe(false);
    expect(w.brief().closed_at).toBe(plus(5 * D));
    expect(w.notices.filter((n) => n.event === "not_hired")).toHaveLength(2);
  });

  it("sends the business's own note once they wrote one", async () => {
    const w = await twoApplicants();
    w.setBrief({ decline_note: "Not this time. The next brief is up on Monday." });
    const res = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D)) },
      w.autoNo,
    );
    expect(res.note).toBe("Not this time. The next brief is up on Monday.");
    expect(w.notices.every((n) => n.note === "Not this time. The next brief is up on Monday.")).toBe(true);
  });

  it("uses a default that does NOT claim anyone watched the intro", async () => {
    const w = await twoApplicants();
    const res = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D)) },
      w.autoNo,
    );
    expect(res.note).toBe(DEFAULT_DECLINE_NOTE);
    const lowered = res.note.toLowerCase();
    for (const claim of ["loved", "watched", "enjoyed", "impressed", "reviewed your"]) {
      expect(lowered).not.toContain(claim);
    }
  });

  it("declines nobody on a brief with no applicants, and says so", async () => {
    const w = world();
    const res = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D)) },
      w.autoNo,
    );
    expect(res.declined).toBe(0);
    expect(res.closed_by_this_call).toBe(true);
  });

  it("is a clean no-op on a brief that is not this tenant's", async () => {
    const w = await twoApplicants();
    const res = await sendAutomaticNos(
      { tenant_id: OTHER_TENANT, brief_id: "b9999999-9999-9999-9999-999999999999", cause: "answer_by" },
      { ...w.autoNo, loadBrief: async () => null },
    );
    expect(res.declined).toBe(0);
    expect(res.closed_by_this_call).toBe(false);
    expect(w.brief().closed_at).toBeNull();
  });

  it("a note that could not be emailed still leaves the decline in place", async () => {
    const w = await twoApplicants();
    const res = await sendAutomaticNos(
      { tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by", now: new Date(plus(5 * D)) },
      {
        ...w.autoNo,
        notify: (async () => {
          throw new Error("sendgrid down");
        }) as AutoNoDeps["notify"],
      },
    );
    expect(res.declined).toBe(2);
    expect(res.notified).toBe(0);
    expect(w.applications.every((a) => a.status === "rejected")).toBe(true);
  });
});

describe("the board (spec item 15, invariant 4)", () => {
  const rows = [
    boardRow(tenantBrief()),
    boardRow(tenantBrief({ id: "b2222222-2222-2222-2222-222222222222", title: "One TikTok post" })),
  ];

  const deps: BoardDeps = {
    listBriefs: async ({ lanes }) => (lanes.length === 0 || lanes.includes("ugc_video") ? rows : []),
    counts: async (ids) => new Map(ids.map((id, i) => [id, i])),
    businessNames: async (ids) => new Map(ids.map((id) => [id, "Northwind Coffee"])),
  };

  it("states the order on screen and gives an honest count", async () => {
    const board = await creatorBoard({ member: { lanes: ["ugc_video"] }, now: new Date(T0) }, deps);
    expect(board.briefs).toHaveLength(2);
    expect(board.order).toContain("Newest first");
    expect(board.count_line).toBe("2 briefs are open right now.");
  });

  it("calls an empty board a real zero rather than hiding it", async () => {
    const board = await creatorBoard({ member: { lanes: ["audience_post"] } }, deps);
    expect(board.briefs).toHaveLength(0);
    expect(board.count_line).toContain("real zero");
  });

  it("fills S10's apply seam: applying is available and points at the route", async () => {
    const board = await creatorBoard({ member: { lanes: ["ugc_video"] } }, deps);
    expect(board.apply.available).toBe(true);
    expect(board.apply.endpoint).toBe("/api/humans/open-briefs/:briefId/apply");
    expect(board.apply.method).toBe("POST");
  });

  it("carries no creator identity, no quote and no private brief column", async () => {
    const board = await creatorBoard({ member: { lanes: ["ugc_video"] } }, deps);
    const payload = JSON.stringify(board);
    for (const denied of [
      "rationale",
      "evidence",
      "utm_campaign",
      "tenant_id",
      "decline_note",
      "quoted_rate_usd",
      "human_member_id",
      "pitch",
    ]) {
      expect(payload, `'${denied}' reached the board`).not.toContain(`"${denied}"`);
    }
  });

  it("shows places left and the answer-by date on every card", async () => {
    const board = await creatorBoard({ member: { lanes: ["ugc_video"] }, now: new Date(T0) }, deps);
    expect(board.briefs[0]?.spots_line).toContain("2 places left");
    expect(board.briefs[1]?.spots_line).toContain("1 place left");
    expect(board.briefs[0]?.answer_by_line).toContain("hears back by");
  });
});
