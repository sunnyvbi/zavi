
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoNoDeps, AutoNoResult } from "@/services/creators/brief-applications";
import type { TenantBriefRow } from "@/services/creators/briefs-db";

import {
  armBriefAnswerBy,
  fireBriefAnswerBy,
  runBriefAnswerBySweep,
} from "../creator-brief-answer-by";

const sent: { name: string; data: Record<string, unknown> }[] = [];
let halted = false;

vi.mock("../../client", () => ({
  inngest: {
    send: async (e: { name: string; data: Record<string, unknown> }) => {
      sent.push(e);
    },
    createFunction: (cfg: unknown, trigger: unknown, handler: unknown) => ({ cfg, trigger, handler }),
  },
}));

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: async () => halted,
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

type AnswerByIo = NonNullable<Parameters<typeof fireBriefAnswerBy>[1]>;

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const BRIEF = "b1111111-1111-1111-1111-111111111111";

const T0 = "2026-09-11T00:00:00.000Z";
const D = 24 * 3_600_000;
const plus = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();
const ANSWER_BY = plus(5 * D);

function brief(over: Partial<TenantBriefRow> = {}): TenantBriefRow {
  return {
    id: BRIEF,
    tenant_id: TENANT,
    status: "sent",
    title: "3 ad videos",
    angle: "a",
    hook: "h",
    format: "9:16",
    deliverables: 3,
    rationale: "r",
    evidence: [],
    source_campaign_ref: "",
    source_run_id: null,
    budget_usd: 450,
    utm_campaign: "zavi-brief-1",
    lane: "ugc_video",
    filters: null,
    delivery_days: 7,
    posted_at: T0,
    answer_by: ANSWER_BY,
    applicant_cap: 20,
    decline_note: null,
    closed_at: null,
    created_at: T0,
    updated_at: null,
    ...over,
  };
}

function io(initial: TenantBriefRow = brief(), pendingApplicants = 2) {
  let row = { ...initial };
  let pending = pendingApplicants;
  const calls: { tenant_id: string; brief_id: string; cause: string }[] = [];

  const impl: AnswerByIo = {
    resolveTenant: async (id) => (id === row.id ? { tenant_id: row.tenant_id, status: row.status } : null),
    loadBrief: async (tenant_id, id) => (tenant_id === row.tenant_id && id === row.id ? { ...row } : null),
    autoNo: (async (
      a: { tenant_id: string; brief_id: string; cause: string; now?: Date },
      _d: AutoNoDeps,
    ): Promise<AutoNoResult> => {
      calls.push({ tenant_id: a.tenant_id, brief_id: a.brief_id, cause: a.cause });
      const closed_by_this_call = !row.closed_at;
      if (closed_by_this_call) row = { ...row, closed_at: (a.now ?? new Date()).toISOString() };
      const declined = pending;
      pending = 0;
      return { declined, notified: declined, closed_by_this_call, note: "note" };
    }) as AnswerByIo["autoNo"],
    autoNoDeps: {} as AutoNoDeps,
    now: () => new Date(plus(5 * D + 1_000)),
  };
  return { impl, calls, brief: () => ({ ...row }), setBrief: (b: Partial<TenantBriefRow>) => {
    row = { ...row, ...b };
  } };
}

beforeEach(() => {
  sent.length = 0;
  halted = false;
});

describe("arming the sleeper", () => {
  it("sends one durable event carrying the sleep target", async () => {
    await armBriefAnswerBy({ brief_id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY });
    expect(sent).toEqual([
      {
        name: "creator/brief.answer_by.armed",
        data: { brief_id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
      },
    ]);
  });
});

describe("the date fires the automatic no", () => {
  it("closes the brief and declines everyone still waiting", async () => {
    const w = io();
    const res = await fireBriefAnswerBy(BRIEF, w.impl);
    expect(res.acted).toBe(true);
    if (!res.acted) return;
    expect(res.result.declined).toBe(2);
    expect(res.result.closed_by_this_call).toBe(true);
    expect(w.calls).toEqual([{ tenant_id: TENANT, brief_id: BRIEF, cause: "answer_by" }]);
  });

  it("EXACTLY ONCE: a replay declines nobody and does not re-close", async () => {
    const w = io();
    const first = await fireBriefAnswerBy(BRIEF, w.impl);
    const second = await fireBriefAnswerBy(BRIEF, w.impl);
    expect(first.acted).toBe(true);
    expect(second).toEqual({ acted: false, reason: "already_closed" });
    expect(w.calls).toHaveLength(1);
  });

  it("C8: re-derives the tenant from the brief, not from the event", async () => {
    const w = io(brief({ tenant_id: TENANT }));
    await fireBriefAnswerBy(BRIEF, w.impl);
    expect(w.calls.every((c) => c.tenant_id === TENANT)).toBe(true);
    expect(w.calls.some((c) => c.tenant_id === OTHER_TENANT)).toBe(false);
  });

  it("no-ops on a brief that no longer exists", async () => {
    const w = io();
    const res = await fireBriefAnswerBy("00000000-0000-0000-0000-000000000000", w.impl);
    expect(res).toEqual({ acted: false, reason: "brief_gone" });
    expect(w.calls).toHaveLength(0);
  });
});

describe("the clock is re-read off the row, so a change while asleep is respected", () => {
  it("waits when the founder pushed the date out", async () => {
    const w = io();
    w.setBrief({ answer_by: plus(20 * D) });
    const res = await fireBriefAnswerBy(BRIEF, w.impl);
    expect(res).toEqual({ acted: false, reason: "not_due" });
    expect(w.calls).toHaveLength(0);
  });

  it("no-ops on a brief a hire already closed, so nobody is told twice", async () => {
    const w = io();
    w.setBrief({ closed_at: plus(D), status: "filled" });
    const res = await fireBriefAnswerBy(BRIEF, w.impl);
    expect(res).toEqual({ acted: false, reason: "already_closed" });
    expect(w.calls).toHaveLength(0);
  });

  it("no-ops on a brief with no answer-by date at all", async () => {
    const w = io();
    w.setBrief({ answer_by: null });
    const res = await fireBriefAnswerBy(BRIEF, w.impl);
    expect(res).toEqual({ acted: false, reason: "no_answer_by" });
  });
});

describe("the hourly sweep (the safety net)", () => {
  const logger = { info: () => {}, error: () => {} };

  it("drains every overdue brief and reports what it did", async () => {
    const w = io();
    const out = await runBriefAnswerBySweep(logger, w.impl, async () => [
      { id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
    ]);
    expect(out).toEqual({ found: 1, acted: 1, skipped: 0, declined: 2 });
  });

  it("claims nothing in steady state", async () => {
    const w = io();
    const out = await runBriefAnswerBySweep(logger, w.impl, async () => []);
    expect(out).toEqual({ found: 0, acted: 0, skipped: 0, declined: 0 });
    expect(w.calls).toHaveLength(0);
  });

  it("IDEMPOTENT: the sleeper and the sweep racing one brief decline it once", async () => {
    const w = io();
    await fireBriefAnswerBy(BRIEF, w.impl);
    const out = await runBriefAnswerBySweep(logger, w.impl, async () => [
      { id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
    ]);
    expect(out.acted).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.declined).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("FAIL-SAFE: defers entirely on a fleet halt rather than mailing blind", async () => {
    halted = true;
    const w = io();
    const out = await runBriefAnswerBySweep(logger, w.impl, async () => [
      { id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
    ]);
    expect(out).toEqual({ found: 0, acted: 0, skipped: 0, declined: 0 });
    expect(w.calls).toHaveLength(0);
  });

  it("one failing brief does not stop the rest of the page", async () => {
    const w = io();
    let n = 0;
    const flaky: typeof w.impl = {
      ...w.impl,
      loadBrief: async (tenant_id, id) => {
        n += 1;
        if (n === 1) throw new Error("read blew up");
        return w.impl.loadBrief(tenant_id, id);
      },
    };
    const out = await runBriefAnswerBySweep(logger, flaky, async () => [
      { id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
      { id: BRIEF, tenant_id: TENANT, answer_by: ANSWER_BY },
    ]);
    expect(out.found).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.acted).toBe(1);
  });
});

describe("a brief that filled its applicant cap", () => {
  it("still gets its answer-by no for every applicant, from the sleeper or the sweep", async () => {
    const { applyToBrief, sendAutomaticNos } = await import("@/services/creators/brief-applications");
    let row = brief({ applicant_cap: 2 });
    const apps: { id: string; human_member_id: string; status: string; brief_id: string; tenant_id: string }[] = [];
    const notes: string[] = [];
    const closeBrief = (async (a: { closed_at: string; status?: string }) => {
      if (row.closed_at) return null;
      row = { ...row, closed_at: a.closed_at, ...(a.status ? { status: a.status } : {}) };
      return { ...row };
    }) as never;
    const members: Record<string, { id: string; display_name: string; vetting_state: string; lanes: string[]; country_code: string }> = {
      ua: { id: "ma", display_name: "A", vetting_state: "approved", lanes: ["ugc_video"], country_code: "US" },
      ub: { id: "mb", display_name: "B", vetting_state: "approved", lanes: ["ugc_video"], country_code: "US" },
    };
    for (const auth of ["ua", "ub"]) {
      const r = await applyToBrief(
        { auth_user_id: auth, brief_id: BRIEF, quoted_rate_usd: 100, now: new Date(plus(D)) },
        {
          loadMember: async (u) => members[u] ?? null,
          loadBrief: async () => ({ ...row }),
          resolveTenant: async () => ({ tenant_id: TENANT, status: row.status }),
          count: async () => apps.length,
          insert: async (a) => {
            const id = `app-${apps.length + 1}`;
            apps.push({ id, human_member_id: a.human_member_id, status: "applied", brief_id: a.brief_id, tenant_id: a.tenant_id });
            return { ok: true, application_id: id };
          },
          businessName: async () => "Northwind",
          closeBrief,
          notify: (async () => ({ written: true, emailed: true })) as never,
        },
      );
      expect(r.ok).toBe(true);
    }
    expect(row.closed_at).toBeNull();

    const autoNoDeps = {
      loadBrief: async () => ({ ...row }),
      closeBrief,
      claim: async () => {
        const moved = apps.filter((a) => a.status === "applied");
        for (const a of moved) a.status = "rejected";
        return moved.map((a) => ({ ...a, brief_kind: "creative", pitch: null, quoted_rate_usd: 100, created_at: T0 }));
      },
      businessName: async () => "Northwind",
      notify: (async (n: { recipient: { human_member_id: string } }) => {
        notes.push(n.recipient.human_member_id);
        return { written: true, emailed: true };
      }) as never,
      liveBookings: async () => [],
      relinkBooking: async () => null,
    } as unknown as AutoNoDeps;
    const ioReal: AnswerByIo = {
      resolveTenant: async () => ({ tenant_id: TENANT, status: row.status }),
      loadBrief: async () => ({ ...row }),
      autoNo: sendAutomaticNos,
      autoNoDeps,
      now: () => new Date(plus(5 * D + 1_000)),
    };
    const list = async (_limit: number, now: Date = new Date()) =>
      !row.closed_at && row.answer_by && row.answer_by <= now.toISOString()
        ? [{ id: row.id, tenant_id: row.tenant_id, answer_by: row.answer_by }]
        : [];

    const swept = await runBriefAnswerBySweep({ info: () => {} }, ioReal, list);
    expect(swept).toEqual({ found: 1, acted: 1, skipped: 0, declined: 2 });
    expect(notes.sort()).toEqual(["ma", "mb"]);
    expect(apps.every((a) => a.status === "rejected")).toBe(true);
    expect(row.closed_at).toBe(plus(5 * D + 1_000));

    const again = await fireBriefAnswerBy(BRIEF, ioReal);
    expect(again).toEqual({ acted: false, reason: "already_closed" });
    expect(notes).toHaveLength(2);
  });
});
