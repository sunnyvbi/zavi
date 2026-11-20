
import { describe, it, expect, vi } from "vitest";
import { resolveDecisionReviser } from "../reviser";

vi.mock("@/services/agents/registry", () => ({
  isChannelOnlyAgent: (slug: string) => slug === "google_ads" || slug === "social",
}));

function clientReturning(result: { data?: unknown; error?: { message: string } }) {
  const calls: Array<Record<string, unknown>> = [];
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      calls.push({ [col]: val });
      return chain;
    },
    maybeSingle: async () => result,
  };
  return {
    client: { from: () => chain } as never,
    calls,
  };
}

const DECISION = {
  id: "d1",
  tenant_id: "t1",
  agent_run_id: "r1",
};

describe("resolveDecisionReviser", () => {
  it("returns the agent that authored the proposal", async () => {
    const { client } = clientReturning({ data: { agent_slug: "performance-marketer" } });
    await expect(resolveDecisionReviser(client, DECISION)).resolves.toEqual({
      ok: true,
      slug: "performance-marketer",
    });
  });

  it("scopes the run lookup to the decision's tenant", async () => {
    const { client, calls } = clientReturning({ data: { agent_slug: "performance-marketer" } });
    await resolveDecisionReviser(client, DECISION);
    expect(calls).toContainEqual({ tenant_id: "t1" });
    expect(calls).toContainEqual({ id: "r1" });
  });

  it("refuses rather than guessing when the decision has no run", async () => {
    const { client } = clientReturning({ data: null });
    const out = await resolveDecisionReviser(client, { ...DECISION, agent_run_id: null });
    expect(out).toMatchObject({ ok: false, code: "reviser_unknown", status: 409 });
  });

  it("refuses when the run exists but records no agent", async () => {
    const { client } = clientReturning({ data: { agent_slug: null } });
    const out = await resolveDecisionReviser(client, DECISION);
    expect(out).toMatchObject({ ok: false, code: "reviser_unknown" });
  });

  it("refuses a CHANNEL-ONLY author instead of failing later with a confusing error", async () => {
    const { client } = clientReturning({ data: { agent_slug: "google_ads" } });
    const out = await resolveDecisionReviser(client, DECISION);
    expect(out).toMatchObject({ ok: false, code: "reviser_channel_only", status: 409 });
    if (!out.ok) expect(out.message).toContain("google_ads");
  });

  it("surfaces a lookup error as a 500, not as an unknown reviser", async () => {
    const { client } = clientReturning({ error: { message: "boom" } });
    const out = await resolveDecisionReviser(client, DECISION);
    expect(out).toMatchObject({ ok: false, code: "reviser_lookup_failed", status: 500 });
  });
});
