import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: Record<string, unknown> }>, answer: { data: null as unknown, error: null as unknown } }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantRpc: async (_tid: string, name: string, args: Record<string, unknown>) => {
    rpc.calls.push({ name, args });
    return rpc.answer;
  },
}));

import { EMAIL_CARD_CAP_PER_RUN, EMAIL_CARD_CAP_PER_TENANT_24H, LIVE_PROPOSE_CAMPAIGN_DEPS, makeProposeCampaignTool, type ProposeCampaignDeps } from "../propose_campaign";
import { ExpectedToolError } from "@/services/tools/types";

const RUN = "4b0d8c1e-3a59-4f6e-9a39-0f1f2b3c4d5e";
const args = {
  route: "mailchimp" as const,
  audience_id: "L1",
  variants: [{ subject: "Hi", preview_text: "p", title: "t", paragraphs: ["a"], button: { label: "Go", url: "https://acme.test" } }],
};
const PAST_CAP = new Error("past the cap check");

function tool(over: Partial<ProposeCampaignDeps>) {
  const resolveTool = vi.fn(async () => {
    throw PAST_CAP;
  });
  const releaseCard = vi.fn(async () => {});
  return { t: makeProposeCampaignTool({ resolveTool: resolveTool as never, releaseCard, runContext: async () => ({ found: true, mode: null }), ...over }), resolveTool, releaseCard };
}
const ctx = (emit = vi.fn(async () => "a-1")) => ({ tenant_id: "t-1", run_id: RUN, log: () => {}, emit_decision: emit }) as never;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no_error";
  } catch (e) {
    return e === PAST_CAP ? "passed_cap" : ((e as { code?: string }).code ?? "unknown");
  }
}

beforeEach(() => {
  rpc.calls = [];
  rpc.answer = { data: null, error: null };
});

describe("propose_campaign card caps", () => {
  it("caps are 3 per run and 20 per tenant per 24h", () => {
    expect([EMAIL_CARD_CAP_PER_RUN, EMAIL_CARD_CAP_PER_TENANT_24H]).toEqual([3, 20]);
  });

  it("the 4th card in a run is refused before anything is drafted or filed", async () => {
    const emit = vi.fn(async () => "a-1");
    const { t, resolveTool } = tool({ reserveCard: async () => ({ ok: false, code: "run_cap", count: 3 }) });
    expect(await codeOf(t.execute(ctx(emit), args))).toBe("email_card_cap_reached");
    expect(resolveTool).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the agent still gets its own instruction for both caps", async () => {
    for (const code of ["run_cap", "tenant_cap"] as const) {
      const { t } = tool({ reserveCard: async () => ({ ok: false, code, count: 20 }) });
      const thrown = (await t.execute(ctx(), args).catch((e: unknown) => e)) as Error;
      expect(thrown.message).toContain("Stop proposing emails and summarise for the founder what is waiting on them.");
      expect(thrown.message).toContain("Nothing was proposed.");
    }
  });

  it("the 21st card for the tenant in 24h is refused", async () => {
    const { t, resolveTool } = tool({ reserveCard: async () => ({ ok: false, code: "tenant_cap", count: 20 }) });
    expect(await codeOf(t.execute(ctx(), args))).toBe("email_card_cap_reached");
    expect(resolveTool).not.toHaveBeenCalled();
  });

  it("a reservation that cannot be made files nothing (fail closed)", async () => {
    const emit = vi.fn(async () => "a-1");
    const { t, resolveTool } = tool({
      reserveCard: async () => {
        throw new Error("db down");
      },
    });
    expect(await codeOf(t.execute(ctx(emit), args))).toBe("email_card_count_unavailable");
    expect(resolveTool).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("under the caps the proposal goes on, reserved for this run", async () => {
    const reserveCard = vi.fn(async () => ({ ok: true as const, id: "res-1" }));
    const { t, resolveTool } = tool({ reserveCard });
    expect(await codeOf(t.execute(ctx(), args))).toBe("passed_cap");
    expect(resolveTool).toHaveBeenCalled();
    expect(reserveCard).toHaveBeenCalledWith("t-1", RUN);
  });

  it("a failure before anything was emitted gives the slot back, whatever the error", async () => {
    const refused = tool({ reserveCard: async () => ({ ok: true, id: "res-1" }) });
    refused.resolveTool.mockImplementation(async () => {
      throw new ExpectedToolError("email_audience_empty", "nobody on it");
    });
    expect(await codeOf(refused.t.execute(ctx(), args))).toBe("email_audience_empty");
    expect(refused.releaseCard).toHaveBeenCalledWith("t-1", "res-1");

    const blip = tool({ reserveCard: async () => ({ ok: true, id: "res-2" }) });
    expect(await codeOf(blip.t.execute(ctx(), args))).toBe("passed_cap");
    expect(blip.releaseCard).toHaveBeenCalledWith("t-1", "res-2");
  });
});

const logged = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async (e: Record<string, unknown>) => void logged.events.push(e) }));

describe("the live release and settle calls", () => {
  beforeEach(() => {
    logged.events = [];
  });

  it("release and settle name the reservation (and the card), with the tenant from tenantRpc", async () => {
    rpc.answer = { data: { ok: true }, error: null };
    await LIVE_PROPOSE_CAMPAIGN_DEPS.releaseCard("t-1", "res-1");
    await LIVE_PROPOSE_CAMPAIGN_DEPS.settleCard("t-1", "res-1", RUN);
    expect(rpc.calls).toEqual([
      { name: "release_email_card_reservation", args: { p_id: "res-1" } },
      { name: "settle_email_card_reservation", args: { p_id: "res-1", p_card_id: RUN } },
    ]);
    expect(logged.events).toEqual([]);
  });

  it("a failed release or settle is logged, never thrown", async () => {
    rpc.answer = { data: null, error: { message: "boom" } };
    await expect(LIVE_PROPOSE_CAMPAIGN_DEPS.releaseCard("t-1", "res-1")).resolves.toBeUndefined();
    rpc.answer = { data: { ok: false, code: "bad_request" }, error: null };
    await expect(LIVE_PROPOSE_CAMPAIGN_DEPS.settleCard("t-1", "res-1", RUN)).resolves.toBeUndefined();
    expect(logged.events.map((e) => e.code)).toEqual(["email_card_reservation_rpc_failed", "email_card_reservation_rpc_failed"]);
  });
});

describe("the live reservation call", () => {
  const reserve = LIVE_PROPOSE_CAMPAIGN_DEPS.reserveCard;

  it("asks reserve_email_card with the run and both caps (the tenant comes from tenantRpc)", async () => {
    rpc.answer = { data: { ok: true, id: "res-9" }, error: null };
    expect(await reserve("t-1", RUN)).toEqual({ ok: true, id: "res-9" });
    expect(rpc.calls).toEqual([{ name: "reserve_email_card", args: { p_run_id: RUN, p_run_cap: 3, p_tenant_cap: 20 } }]);
  });

  it("a run id that is not a uuid is reserved against the tenant cap only", async () => {
    rpc.answer = { data: { ok: true, id: "res-9" }, error: null };
    await reserve("t-1", "not-a-run");
    expect(rpc.calls[0].args.p_run_id).toBeNull();
  });

  it("reads a cap refusal, and throws on an RPC error or an unknown answer", async () => {
    rpc.answer = { data: { ok: false, code: "run_cap", count: 3 }, error: null };
    expect(await reserve("t-1", RUN)).toEqual({ ok: false, code: "run_cap", count: 3 });
    rpc.answer = { data: null, error: { message: "boom" } };
    await expect(reserve("t-1", RUN)).rejects.toThrow();
    rpc.answer = { data: { ok: false, code: "bad_request" }, error: null };
    await expect(reserve("t-1", RUN)).rejects.toThrow();
  });
});
