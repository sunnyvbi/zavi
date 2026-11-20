import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached: every read is injected");
  },
}));
vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({ id: "dispatch-channel-action" }), send: vi.fn() },
}));

import { runChannelActionMutation, type ExecDeps } from "../dispatch-channel-action";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTION = "99999999-9999-4999-8999-999999999999";
const BUNDLE = "linkedin_ads.create_campaign_bundle";

function deps(execClass: string, progress: () => Promise<unknown>, gate: Partial<ExecDeps>) {
  const handler = vi.fn(async () => ({ ok: true }));
  const execProgressOf = vi.fn(progress);
  const d: Partial<ExecDeps> = {
    claim: (async () => ({
      ok: true,
      row: { claim_id: "claim-1", tenant_id: TENANT, channel_slug: execClass.split(".")[0], exec_class: execClass, exec_payload: {}, approved_by: "founder", approved_by_source: null, agent_run_id: null },
    })) as unknown as ExecDeps["claim"],
    loadHandler: async () => handler as never,
    writeEnabled: async () => true,
    tenantDisabled: async () => false,
    channelStopped: async () => false,
    channelLock: (async () => null) as unknown as ExecDeps["channelLock"],
    releaseClaim: async () => false,
    execClassOf: async () => execClass,
    retimeFlight: async (r) => r.exec_payload,
    tellOutcome: async () => "not_a_direct_ask" as never,
    envelopeSwitchedOff: async () => false,
    testStopPause: async () => null,
    execProgressOf,
    ...gate,
  };
  return { d, handler, execProgressOf };
}

const GATES: Array<[string, Partial<ExecDeps>]> = [
  ["the workspace is disabled", { tenantDisabled: async () => true }],
  ["the workspace flag could not be read", { tenantDisabled: async () => null }],
  ["LinkedIn changes are switched off for every workspace", { writeEnabled: async () => false }],
  ["the plan no longer includes LinkedIn Ads", { channelLock: (async () => ({ slug: "linkedin_ads", required_tier: "pro" })) as unknown as ExecDeps["channelLock"] }],
  ["the founder stopped the channel", { channelStopped: async () => true }],
  ["the channel stop could not be read", { channelStopped: async () => null }],
];

const made = { version: 1, payload_hash: "h", account_binding_id: "b", group_id: "600", campaign_id: "700", creative_id: null, in_flight: null, group_paused: true };

describe("a LinkedIn campaign Try again stopped by a gate tells the founder what an earlier try left in LinkedIn", () => {
  it.each(GATES)("when %s, it names the group and campaign still in LinkedIn and never says nothing changed", async (_label, gate) => {
    const { d, handler } = deps(BUNDLE, async () => made, gate);
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(handler).not.toHaveBeenCalled();
    expect(out.settle?.ok).toBe(false);
    const error = out.settle?.error ?? "";
    expect(error).toContain("What it made on an earlier try, the campaign group and the paused campaign, is still in LinkedIn and stays paused, so nothing can spend.");
    expect(error).not.toContain("Nothing in the account changed");
  });

  it.each(GATES)("when %s on a first try with nothing made yet, it still says nothing changed", async (_label, gate) => {
    const { d } = deps(BUNDLE, async () => null, gate);
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(out.settle?.error).toContain("Nothing in the account changed.");
  });

  it("an unreadable progress row never claims nothing changed", async () => {
    const { d } = deps(BUNDLE, async () => { throw new Error("db down"); }, { channelStopped: async () => true });
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(out.settle?.error).toBe("You stopped this channel, so Zavi did not apply this change. Zavi made no new change in LinkedIn this time. Anything it made on an earlier try is still there, as it was.");
  });

  it("a create left in flight says an earlier try may have reached LinkedIn", async () => {
    const { d } = deps(BUNDLE, async () => ({ ...made, group_id: null, campaign_id: null, group_paused: false, in_flight: "group_id" }), { tenantDisabled: async () => true });
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(out.settle?.error).toContain("An earlier try may have reached LinkedIn");
    expect(out.settle?.error).not.toContain("Nothing in the account changed");
  });

  it("other changes keep the plain line and never read creation progress", async () => {
    const { d, execProgressOf } = deps("google_ads.update_campaign_budget", async () => made, { channelStopped: async () => true });
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(out.settle?.error).toBe("You stopped this channel, so Zavi did not apply this change. Nothing in the account changed.");
    expect(execProgressOf).not.toHaveBeenCalled();
  });

  it("a campaign that passes every gate never reads creation progress", async () => {
    const { d, handler, execProgressOf } = deps(BUNDLE, async () => made, {});
    await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(execProgressOf).not.toHaveBeenCalled();
  });
});
