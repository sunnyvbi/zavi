import { beforeEach, describe, expect, it, vi } from "vitest";

let owner: { user_id: string } | null = { user_id: "owner-1" };
let decisionStatus = "proposed";
let readError: Error | null = null;
let card: Record<string, unknown> = { target_agent_slug: "research", intent: "look into it" };
let decisionReads = 0;
const send = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("@/../workers/client", () => ({ inngest: { send: (e: Record<string, unknown>) => send(e) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table !== "decisions") return { data: owner, error: null };
              if (decisionReads++ === 0) return { data: { status: "proposed", decision_class: "cgo.dispatch-specialist", body: card }, error: null };
              return { data: readError ? null : { status: decisionStatus }, error: readError };
            },
          }),
        }),
      }),
    }),
  }),
}));
const decide = vi.fn();
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: (...a: unknown[]) => decide(...a) }));
const logEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: Record<string, unknown>) => logEvent(e) }));

let autopilot = true;
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => autopilot }));

import { autoRunCgoCard } from "../cgo-auto-run";

beforeEach(() => {
  autopilot = true;
  owner = { user_id: "owner-1" };
  decisionStatus = "proposed";
  readError = null;
  card = { target_agent_slug: "research", intent: "look into it" };
  decisionReads = 0;
  send.mockClear();
  decide.mockReset();
  logEvent.mockClear();
});

describe("autoRunCgoCard", () => {
  it("approves through the normal approval service for the tenant owner, as the cgo source, and logs it", async () => {
    decide.mockResolvedValue({ ok: true, changed: true });
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(true);
    expect(decide).toHaveBeenCalledWith({
      decision_id: "d-1",
      tenant_id: "t-1",
      action: "approve",
      actor: { user_id: "owner-1" },
      approver_source: "cgo",
    });
    expect(logEvent.mock.calls[0][0]).toMatchObject({ code: "cgo.card_auto_run", tenant_id: "t-1" });
  });

  it("the unattended gate runs first: a target cgo may not start is never approved (S1)", async () => {
    card = { target_agent_slug: "engineer", intent: "ship it" };
    decide.mockResolvedValue({ ok: true, changed: true });
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(logEvent.mock.calls[0][0]).toMatchObject({ code: "cgo.unattended_deny", tenant_id: "t-1" });
  });

  it("Autopilot turned off after the review was queued: research is not started (live re-check)", async () => {
    autopilot = false;
    decide.mockResolvedValue({ ok: true, changed: true });
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("no owner: nothing is approved", async () => {
    owner = null;
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("a refused or failing approval leaves the card for the founder", async () => {
    decide.mockResolvedValue({ ok: false, code: "not_found", changed: false });
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
    decisionReads = 0;
    decide.mockRejectedValue(new Error("boom"));
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
  });

  it("approve committed but its event never landed: re-sends it (same id) and reports started", async () => {
    decide.mockRejectedValue(new Error("fan-out send failed"));
    decisionStatus = "approved";
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({ id: "approve:d-1", name: "decision.approved", data: { decision_id: "d-1", tenant_id: "t-1" } });
  });

  it("already picked up by dispatch counts as started without a re-send", async () => {
    decide.mockRejectedValue(new Error("late throw"));
    decisionStatus = "acted";
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed re-read or a failed re-send is not reported as started", async () => {
    decide.mockRejectedValue(new Error("boom"));
    readError = new Error("db down");
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
    readError = null;
    decisionStatus = "approved";
    send.mockRejectedValueOnce(new Error("inngest down"));
    expect(await autoRunCgoCard("t-1", "d-1")).toBe(false);
  });
});
