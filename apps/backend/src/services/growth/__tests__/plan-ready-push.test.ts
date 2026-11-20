import { describe, expect, it, vi } from "vitest";

vi.mock("@/email/sendAuthEmail", () => ({ resolveSequenceRecipient: vi.fn(), sendPlanReadyEmail: vi.fn() }));
vi.mock("@/services/onboarding-emails/sequence", () => ({ unsubscribeUrlFor: (t: string) => `https://api.test/unsub?t=${t}` }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { maybeSendPlanReadyPush, PLAN_READY_PUSH_BODY, type PlanReadyPushDeps } from "../plan-ready-push";
import { PLAN_READY_SUBJECT } from "@/email/templates/plan-ready";
import type { PlanReadyFacts } from "../plan-ready-email";

const FIRST_PLAN: PlanReadyFacts = {
  enabled: true,
  mailable: true,
  appliedPlans: 1,
  planOpened: false,
  owner: { user_id: "u1", optedOut: false, unsubToken: "tok" },
  company: "Acme",
};

function harness(facts: Partial<PlanReadyFacts> = {}, tenant: string | null = "t1") {
  const send = vi.fn(async () => ({ sent: 1 }));
  const deps = {
    tenantOfRun: vi.fn(async () => tenant),
    facts: vi.fn(async () => ({ ...FIRST_PLAN, ...facts })),
    send,
  } as unknown as PlanReadyPushDeps;
  return { deps, send };
}

describe("plan-ready push", () => {
  it("sends one push to the owner, in the run's workspace, that opens Growth", async () => {
    const { deps, send } = harness();
    expect(await maybeSendPlanReadyPush("run-1", deps)).toEqual({ sent: 1 });
    expect(deps.tenantOfRun).toHaveBeenCalledWith("run-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      tenant_id: "t1",
      kind: "result_milestone",
      agent_slug: "cgo",
      thread_id: null,
      title: PLAN_READY_SUBJECT,
      body: PLAN_READY_PUSH_BODY,
      user_id: "u1",
    });
  });

  it("is not stopped by the email's own switches: opt-out and the sequence setting", async () => {
    const optedOut = harness({ owner: { user_id: "u1", optedOut: true, unsubToken: null } });
    expect((await maybeSendPlanReadyPush("run-1", optedOut.deps)).sent).toBe(1);
    const off = harness({ enabled: false });
    expect((await maybeSendPlanReadyPush("run-1", off.deps)).sent).toBe(1);
  });

  it.each([
    ["the plan was already opened", { planOpened: true }, "plan_opened"],
    ["it is not the first plan", { appliedPlans: 2 }, "not_first_plan"],
    ["no plan was applied", { appliedPlans: 0 }, "no_plan"],
    ["a test, dogfood or deleted workspace", { mailable: false }, "not_mailable"],
    ["the workspace has no owner", { owner: null }, "no_owner"],
  ] as const)("sends nothing when %s", async (_why, facts, reason) => {
    const { deps, send } = harness(facts as Partial<PlanReadyFacts>);
    expect(await maybeSendPlanReadyPush("run-1", deps)).toEqual({ sent: 0, reason });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for a run it cannot find", async () => {
    const { deps, send } = harness({}, null);
    expect(await maybeSendPlanReadyPush("run-1", deps)).toEqual({ sent: 0, reason: "run_not_found" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports why nothing went out when the owner has no phone registered", async () => {
    const { deps, send } = harness();
    send.mockResolvedValueOnce({ sent: 0, skipped_reason: "no_devices" } as never);
    expect(await maybeSendPlanReadyPush("run-1", deps)).toEqual({ sent: 0, reason: "no_devices" });
  });

  it("lets a failed read throw, so the step retries with nothing sent", async () => {
    const { deps, send } = harness();
    (deps.facts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(maybeSendPlanReadyPush("run-1", deps)).rejects.toThrow("db down");
    expect(send).not.toHaveBeenCalled();
  });
});
