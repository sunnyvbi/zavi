import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/email/sendAuthEmail", () => ({ resolveSequenceRecipient: vi.fn(), sendPlanReadyEmail: vi.fn() }));
vi.mock("@/services/onboarding-emails/sequence", () => ({ unsubscribeUrlFor: (t: string) => `https://api.test/unsub?t=${t}` }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import {
  maybeSendPlanReadyEmail,
  planReadyDecision,
  planReadyDeps,
  sweepPlanReadyEmails,
  PLAN_READY_SWEEP_LIMIT,
  PLAN_READY_SWEEP_MIN_AGE_MS,
  sweepOutcomeIsFinal,
  type PlanReadyOutcome,
  type PlanReadyDeps,
  type PlanReadyFacts,
  type PlanReadySweepDeps,
} from "../plan-ready-email";
import { EmailNotSentError } from "@/services/onboarding-emails/send-errors";
import { renderPlanReadyEmail } from "@/email/templates/plan-ready";

const FIRST_PLAN: PlanReadyFacts = {
  enabled: true,
  mailable: true,
  appliedPlans: 1,
  planOpened: false,
  owner: { user_id: "u1", optedOut: false, unsubToken: "tok" },
  company: "Acme",
};

function harness(facts: Partial<PlanReadyFacts> = {}, opts: { verified?: boolean; claimed?: boolean; sendError?: unknown } = {}) {
  const sends: unknown[] = [];
  const deps: PlanReadyDeps = {
    tenantOfRun: vi.fn(async () => "t1"),
    facts: vi.fn(async () => ({ ...FIRST_PLAN, ...facts })),
    resolveRecipient: vi.fn(async () => ({ email: "owner@example.com", verified: opts.verified ?? true, name: "Dana Smith" })),
    claim: vi.fn(async () => !opts.claimed),
    release: vi.fn(async () => {}),
    send: vi.fn(async (a) => {
      if (opts.sendError) throw opts.sendError;
      sends.push(a);
    }),
    links: () => ({ planUrl: "https://app.test/workspace?tab=growth-strategy&company=t1", imageBaseUrl: "https://app.test" }),
  };
  return { deps, sends };
}

describe("plan-ready email: attribution link", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("tags the real plan link while preserving its destination, company and image base", () => {
    vi.stubEnv("WEB_BASE_URL", "https://app.example.test");
    const links = planReadyDeps.links("t1");
    const url = new URL(links.planUrl);
    expect(url.origin).toBe("https://app.example.test");
    expect(url.pathname).toBe("/workspace");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tab: "growth-strategy", company: "t1",
      utm_source: "email", utm_medium: "zavi", utm_campaign: "plan_ready",
    });
    expect(links.imageBaseUrl).toBe("https://app.example.test");
    const email = renderPlanReadyEmail({ firstName: "Dana", company: "Example", unsubscribeUrl: "https://api.example.test/unsubscribe", ...links });
    expect(email.text).toContain(links.planUrl);
    expect(email.html).toContain(links.planUrl.replaceAll("&", "&amp;"));
  });
});

describe("plan-ready email: send or skip", () => {
  it("first plan applied and not opened: sends once, to the owner, with the plan link and opt-out", async () => {
    const { deps, sends } = harness();
    expect(await maybeSendPlanReadyEmail("run-1", deps)).toEqual({ sent: true });
    expect(deps.claim).toHaveBeenCalledWith("t1");
    expect(sends).toEqual([
      {
        to: "owner@example.com",
        firstName: "Dana",
        company: "Acme",
        planUrl: "https://app.test/workspace?tab=growth-strategy&company=t1",
        imageBaseUrl: "https://app.test",
        unsubscribeUrl: "https://api.test/unsub?t=tok",
      },
    ]);
  });

  it("plan already opened: no email, no claim", async () => {
    const { deps, sends } = harness({ planOpened: true });
    expect(await maybeSendPlanReadyEmail("run-1", deps)).toEqual({ sent: false, reason: "plan_opened" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it("second apply of the same workspace: the claim is taken, nothing sent", async () => {
    const { deps, sends } = harness({}, { claimed: true });
    expect(await maybeSendPlanReadyEmail("run-2", deps)).toEqual({ sent: false, reason: "already_claimed" });
    expect(sends).toHaveLength(0);
  });

  it("a later plan (Start over) is not the first: no email", async () => {
    const { deps, sends } = harness({ appliedPlans: 2 });
    expect(await maybeSendPlanReadyEmail("run-3", deps)).toEqual({ sent: false, reason: "not_first_plan" });
    expect(sends).toHaveLength(0);
  });

  it("owner unsubscribed from the onboarding emails: no email", async () => {
    const { deps, sends } = harness({ owner: { user_id: "u1", optedOut: true, unsubToken: "tok" } });
    expect(await maybeSendPlanReadyEmail("run-1", deps)).toEqual({ sent: false, reason: "opted_out" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it("unverified address: no email, no claim", async () => {
    const { deps, sends } = harness({}, { verified: false });
    expect(await maybeSendPlanReadyEmail("run-1", deps)).toEqual({ sent: false, reason: "unverified" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(sends).toHaveLength(0);
  });

  it("run not found: nothing read, nothing sent (tenant comes from the run row)", async () => {
    const { deps } = harness();
    deps.tenantOfRun = vi.fn(async () => null);
    expect(await maybeSendPlanReadyEmail("run-x", deps)).toEqual({ sent: false, reason: "run_not_found" });
    expect(deps.facts).not.toHaveBeenCalled();
  });

  it("a definite rejection gives the claim back; an ambiguous error keeps it", async () => {
    const rejected = harness({}, { sendError: new EmailNotSentError("render failed") });
    expect(await maybeSendPlanReadyEmail("run-1", rejected.deps)).toEqual({ sent: false, reason: "failed" });
    expect(rejected.deps.release).toHaveBeenCalledWith("t1");

    const timeout = harness({}, { sendError: new Error("socket hang up") });
    expect(await maybeSendPlanReadyEmail("run-1", timeout.deps)).toEqual({ sent: false, reason: "unconfirmed" });
    expect(timeout.deps.release).not.toHaveBeenCalled();
  });

  it("decision table: switch off, test/dogfood workspace, no plan, no owner", () => {
    expect(planReadyDecision({ ...FIRST_PLAN, enabled: false })).toEqual({ send: false, reason: "disabled" });
    expect(planReadyDecision({ ...FIRST_PLAN, mailable: false })).toEqual({ send: false, reason: "not_mailable" });
    expect(planReadyDecision({ ...FIRST_PLAN, appliedPlans: 0 })).toEqual({ send: false, reason: "no_plan" });
    expect(planReadyDecision({ ...FIRST_PLAN, owner: null })).toEqual({ send: false, reason: "no_owner" });
    expect(planReadyDecision(FIRST_PLAN)).toEqual({ send: true });
  });
});

describe("plan-ready email copy", () => {
  it("names the company, links the plan (escaped in HTML), and has no em dash", () => {
    const r = renderPlanReadyEmail({
      firstName: "Dana",
      company: "Acme <Co>",
      planUrl: "https://app.test/workspace?tab=growth-strategy&company=t1",
      imageBaseUrl: "https://app.test",
      unsubscribeUrl: "https://api.test/unsub?t=tok",
    });
    expect(r.subject).toBe("Your growth plan is ready");
    expect(r.text).toContain("Your growth plan for Acme <Co> is ready.");
    expect(r.text).toContain("Open your growth plan: https://app.test/workspace?tab=growth-strategy&company=t1");
    expect(r.html).toContain("Acme &lt;Co&gt;");
    expect(r.html).toContain("tab=growth-strategy&amp;company=t1");
    expect(r.html).toContain("https://api.test/unsub?t=tok");
    expect(`${r.subject}${r.text}`).not.toContain("—");
  });

  it("without an opt-out link, no unsubscribe line", () => {
    const r = renderPlanReadyEmail({ firstName: "there", company: "", planUrl: "https://app.test/w", imageBaseUrl: "https://app.test", unsubscribeUrl: "" });
    expect(r.text).toContain("Your growth plan for your business is ready.");
    expect(r.text).not.toContain("Unsubscribe");
  });
});

describe("plan-ready email: hourly sweep for a lost arm", () => {
  const NOW = new Date("2026-10-28T12:00:00Z");
  type R = { tenant_id: string; run_id: string; updated_at: string };
  const row = (tenant_id: string, run_id: string, i: number): R => ({ tenant_id, run_id, updated_at: new Date(NOW.getTime() - 30 * 3600_000 + i * 1000).toISOString() });
  function sweep(rows: R[], claimed: Set<string> = new Set(), outcome: (run_id: string) => PlanReadyOutcome = () => ({ sent: true })) {
    const sent: string[] = [];
    const settled = new Set<string>();
    const windows: Array<[string, string]> = [];
    const deps: PlanReadySweepDeps = {
      appliedPlans: async (from, to, after, size) => {
        windows.push([from, to]);
        const key = (r: R) => `${r.updated_at}|${r.run_id}`;
        return rows
          .filter((r) => !settled.has(r.run_id))
          .filter((r) => !after || key(r) > `${after.updated_at}|${after.run_id}`)
          .sort((x, y) => (key(x) < key(y) ? -1 : 1))
          .slice(0, size);
      },
      claimed: async (t) => claimed.has(t),
      send: async (run_id) => {
        sent.push(run_id);
        return outcome(run_id);
      },
      settle: async (run_id) => {
        settled.add(run_id);
      },
    };
    return { deps, sent, settled, windows };
  }

  it("sends for an unclaimed first plan applied at least 15 minutes ago, once per workspace", async () => {
    const { deps, sent, windows } = sweep([row("t1", "run-a", 1), row("t1", "run-b", 2), row("t2", "run-c", 3)]);
    expect(await sweepPlanReadyEmails(NOW, deps)).toEqual({ checked: 2, sent: 2, settled: 2, failed: 0 });
    expect(sent).toEqual(["run-a", "run-c"]);
    expect(windows[0]![1]).toBe(new Date(NOW.getTime() - PLAN_READY_SWEEP_MIN_AGE_MS).toISOString());
  });

  it("settles a workspace that already got its ready email, without sending", async () => {
    const { deps, sent, settled } = sweep([row("t1", "run-a", 1)], new Set(["t1"]));
    expect(await sweepPlanReadyEmails(NOW, deps)).toEqual({ checked: 0, sent: 0, settled: 1, failed: 0 });
    expect(sent).toEqual([]);
    expect(settled.has("run-a")).toBe(true);
  });

  it("a final skip (plan already opened) is settled and never read again, so it cannot crowd out a later unsent plan", async () => {
    const opened = Array.from({ length: PLAN_READY_SWEEP_LIMIT + 20 }, (_, i) => row(`o${i}`, `ro${i}`, i));
    const late = row("late", "run-late", 10_000);
    const { deps, sent } = sweep([...opened, late], new Set(), (id) => (id === "run-late" ? { sent: true } : { sent: false, reason: "plan_opened" }));
    const first = await sweepPlanReadyEmails(NOW, deps);
    expect(first).toMatchObject({ checked: PLAN_READY_SWEEP_LIMIT });
    expect(sent).not.toContain("run-late");
    const second = await sweepPlanReadyEmails(NOW, deps);
    expect(second).toMatchObject({ checked: 21, sent: 1 });
    expect(sent).toContain("run-late");
  });

  it("a send SendGrid rejected stays unsettled and is tried again next hour", async () => {
    const { deps, settled } = sweep([row("t1", "run-a", 1)], new Set(), () => ({ sent: false, reason: "failed" }));
    expect(await sweepPlanReadyEmails(NOW, deps)).toEqual({ checked: 1, sent: 0, settled: 0, failed: 0 });
    expect(settled.size).toBe(0);
    expect(sweepOutcomeIsFinal({ sent: false, reason: "failed" })).toBe(false);
    for (const reason of ["unverified", "no_address", "no_owner", "disabled"] as const) {
      expect(sweepOutcomeIsFinal({ sent: false, reason })).toBe(false);
    }
    for (const reason of ["already_claimed", "plan_opened", "not_first_plan", "opted_out", "not_mailable"] as const) {
      expect(sweepOutcomeIsFinal({ sent: false, reason })).toBe(true);
    }
    expect(sweepOutcomeIsFinal({ sent: true })).toBe(true);
  });

  it("one workspace failing does not stop the rest", async () => {
    const { deps, sent } = sweep([row("t1", "run-a", 1), row("t2", "run-c", 2)]);
    deps.claimed = async (t) => {
      if (t === "t1") throw new Error("settings down");
      return false;
    };
    expect(await sweepPlanReadyEmails(NOW, deps)).toEqual({ checked: 1, sent: 1, settled: 1, failed: 1 });
    expect(sent).toEqual(["run-c"]);
  });
});
