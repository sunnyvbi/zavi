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
const stop = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("@/services/growth/channel-stopped", () => ({
  readChannelStopped: vi.fn(async (t: string, slug: string) => {
    stop.calls.push([t, slug]);
    return true;
  }),
}));
const pause = vi.hoisted(() => vi.fn(async () => ({ ok: true, notice: "Paused \"Spring\" in LinkedIn Ads." })));
vi.mock("@/services/connectors/linkedin-ads/execute-pause", () => ({ executeLinkedInPause: pause }));

import { runChannelActionMutation, type ExecDeps } from "../dispatch-channel-action";
import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTION = "99999999-9999-4999-8999-999999999999";
const PAUSE_BODY = { campaign_id: "700", account_id: "500", status: "PAUSED", name: "Spring" };

function deps(execClass: string, stopped: boolean | null) {
  const handler = vi.fn(async () => ({ ok: true }));
  const channelStopped = vi.fn(async () => stopped);
  const d: Partial<ExecDeps> = {
    claim: (async () => ({
      ok: true,
      row: { claim_id: "claim-1", tenant_id: TENANT, channel_slug: execClass.split(".")[0], exec_class: execClass, exec_payload: PAUSE_BODY, approved_by: "founder", approved_by_source: null, agent_run_id: null },
    })) as unknown as ExecDeps["claim"],
    loadHandler: async () => handler as never,
    writeEnabled: async () => true,
    tenantDisabled: async () => false,
    channelStopped,
    channelLock: (async () => null) as unknown as ExecDeps["channelLock"],
    releaseClaim: async () => false,
    execClassOf: async () => execClass,
    retimeFlight: async (r) => r.exec_payload,
    tellOutcome: async () => "not_a_direct_ask" as never,
    envelopeSwitchedOff: async () => false,
    testStopPause: async () => null,
    execProgressOf: async () => null,
  };
  return { d, handler, channelStopped };
}

describe("a LinkedIn pause on a channel the founder stopped", () => {
  it.each([
    ["stopped", true],
    ["stop unreadable", null],
  ] as const)("must-catch: the pause still runs on the channel-action rail (%s)", async (_l, stopped) => {
    const { d, handler } = deps("linkedin_ads.set_status", stopped);
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(out.settle?.error ?? "").not.toMatch(/You stopped this channel|could not check whether you stopped/);
  });

  it("must-catch: the pause still reaches LinkedIn on the shared handler", async () => {
    stop.calls.length = 0;
    pause.mockClear();
    const r = await HANDLERS["linkedin_ads.set_status"]({
      id: "a-1", tenant_id: TENANT, agent_run_id: null, decision_class: "linkedin_ads.set_status", status: "dispatching", handler: null, body: PAUSE_BODY, approved_by: "founder", approved_by_source: null,
    } as never);
    expect(r).toMatchObject({ ok: true });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(stop.calls).toEqual([]);
  });

  it("must-not-touch: a LinkedIn launch on a stopped channel is still refused before its handler", async () => {
    const { d, handler } = deps("linkedin_ads.create_campaign_bundle", true);
    const out = await runChannelActionMutation(ACTION, d, { retryable: false });
    expect(handler).not.toHaveBeenCalled();
    expect(out.settle?.error).toMatch(/^You stopped this channel/);
  });
});
