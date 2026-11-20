import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({ cgoApprove: vi.fn() }));
const flatPricing = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/billing/flat-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => flatPricing.on,
}));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: hoisted.cgoApprove }));

import {
  startGeneratedVideoRender,
  CHANNEL_VIDEO_EVENT,
  GENERATED_VIDEO_RENDER_CLASS,
  RENDER_UNCONFIRMED,
  type RenderDeps,
  type RenderRow,
} from "../generated-video-render";
import { runChannelActionMutation, type ExecDeps } from "../../../../workers/functions/dispatch-channel-action";
import { recordChannelExecAction } from "../exec-actions";
import type { ClaimResult } from "../exec-actions";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const ACTION = "33333333-3333-3333-3333-333333333333";
const CLAIM = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

const INTAKE = {
  prompt: "A generic AI presenter at a desk. Vertical 9:16 UGC-style video.",
  intent: "talking_head",
  premium: false,
  aspect_ratio: "9:16",
  script: "Setup took four minutes and that was the whole job. Connect the calendar, pick the shifts, and the rota fills itself every week.",
};

const row = (over: Partial<RenderRow> = {}): RenderRow => ({
  id: ACTION,
  tenant_id: TENANT,
  agent_run_id: RUN,
  body: { intake: INTAKE, format: "product_demo" },
  approved_by: USER,
  approved_by_source: null,
  exec_source: "channel_actions",
  claim_id: CLAIM,
  ...over,
});

function deps(over: Partial<RenderDeps> = {}): RenderDeps & { send: ReturnType<typeof vi.fn> } {
  return {
    routerEnabled: vi.fn(async () => true),
    videoEnabled: vi.fn(async () => true),
    afford: vi.fn(async () => "ok" as const),
    send: vi.fn(async () => undefined),
    channelLocked: vi.fn(async () => false),
    ...over,
  } as RenderDeps & { send: ReturnType<typeof vi.fn> };
}

beforeEach(() => hoisted.cgoApprove.mockReset());

describe("startGeneratedVideoRender", () => {
  it("queues exactly one render keyed on the action and this attempt's claim, and defers", async () => {
    const d = deps();
    const out = await startGeneratedVideoRender(row(), d);
    expect(out).toEqual({ ok: true, deferred: true });
    expect(d.send).toHaveBeenCalledTimes(1);
    const evt = d.send.mock.calls[0][0];
    expect(evt.name).toBe(CHANNEL_VIDEO_EVENT);
    expect(evt.id).toBe(`ca-${ACTION}-${CLAIM}`);
    expect(evt.data).toMatchObject({
      run_id: RUN,
      render_key: `ca-${ACTION}-${CLAIM}`,
      delivery_target: { kind: "channel_action", action_id: ACTION, claim_id: CLAIM },
    });
  });

  it("not enough credits: nothing is queued and the card gets the credits line", async () => {
    const d = deps({ afford: vi.fn(async () => "short" as const) });
    const out = await startGeneratedVideoRender(row(), d);
    expect(out.ok).toBe(false);
    expect(out.code).toBe("insufficient_credits");
    expect(out.error).toMatch(/credits/);
    expect(out.error).toMatch(/Top up/);
    expect(out.error).toMatch(/nothing was charged/i);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("an unreadable wallet fails closed without claiming a shortfall", async () => {
    const d = deps({ afford: vi.fn(async () => "unknown" as const) });
    const out = await startGeneratedVideoRender(row(), d);
    expect(out).toMatchObject({ ok: false, code: "afford_check_unavailable" });
    expect(out.error).not.toMatch(/fewer than/);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a send that times out may have reached the queue, so the card never claims nothing was made or charged", async () => {
    const send = vi.fn(async () => {
      throw new Error("Request timed out after 10000ms");
    });
    const d = deps({ send });
    const out = await startGeneratedVideoRender(row(), d);
    expect(send).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect(out.error).toBe(RENDER_UNCONFIRMED);
    expect(out.error).toMatch(/could not confirm this video started/);
    expect(out.error).toMatch(/only charged for a video that is made/);
    expect(out.error).not.toMatch(/could not be started|nothing was made|nothing was charged|not charged/i);
    expect(out.error).toMatch(/Try again/);
  });

  it("refuses a CGO or staff approval: a person has to approve a video", async () => {
    for (const source of ["cgo", "staff"]) {
      const d = deps();
      const out = await startGeneratedVideoRender(row({ approved_by_source: source }), d);
      expect(out.ok).toBe(false);
      expect(d.send).not.toHaveBeenCalled();
      expect(d.afford).not.toHaveBeenCalled();
    }
  });

  it("refuses a row that did not come through the channel-action claim (the decisions rail)", async () => {
    const d = deps();
    expect((await startGeneratedVideoRender(row({ exec_source: undefined }), d)).ok).toBe(false);
    expect((await startGeneratedVideoRender(row({ claim_id: null }), d)).ok).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("refuses with the media router off: Zavi credits are the only rail", async () => {
    const d = deps({ routerEnabled: vi.fn(async () => false) });
    const out = await startGeneratedVideoRender(row(), d);
    expect(out).toMatchObject({ ok: false, code: "video_unavailable" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a channel staff switched off after the card was filed queues nothing and charges nothing", async () => {
    const d = deps({ channelLocked: vi.fn(async () => true) });
    const out = await startGeneratedVideoRender(row(), d);
    expect(out).toMatchObject({ ok: false, code: "video_unavailable" });
    expect((out as { error: string }).error).toMatch(/switched off/i);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.afford).not.toHaveBeenCalled();
  });

  it("an unreadable channel switch fails closed: nothing is queued", async () => {
    const d = deps({ channelLocked: vi.fn(async () => { throw new Error("db down"); }) });
    const out = await startGeneratedVideoRender(row(), d);
    expect(out).toMatchObject({ ok: false, code: "video_unavailable" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("re-prices from the stored intake, never from a number on the card", async () => {
    const afford = vi.fn(async () => "ok" as const);
    await startGeneratedVideoRender(row({ body: { intake: INTAKE, cost_credits: 1 } }), deps({ afford }));
    const usd = (afford.mock.calls[0] as unknown[])[1] as number;
    expect(usd).toBeGreaterThan(0);
  });
});

describe("through the channel-action worker", () => {
  const claimed = (): ClaimResult => ({
    ok: true,
    row: {
      claim_id: CLAIM,
      tenant_id: TENANT,
      channel_slug: "generated_video",
      exec_class: GENERATED_VIDEO_RENDER_CLASS,
      exec_payload: { intake: INTAKE, format: "product_demo" },
      approved_by: USER,
      approved_by_source: null,
      agent_run_id: RUN,
    },
  });

  function execDeps(send: RenderDeps["send"], claim: ExecDeps["claim"], afford: RenderDeps["afford"] = vi.fn(async () => "ok" as const)): Partial<ExecDeps> {
    return {
      claim,
      writeEnabled: vi.fn(async () => true),
      channelLock: vi.fn(async () => null),
      tenantDisabled: vi.fn(async () => false),
      loadHandler: async () => (d) => startGeneratedVideoRender(d as unknown as RenderRow, deps({ send, afford })),
    };
  }

  it("two overlapping approvals start exactly ONE render", async () => {
    const send = vi.fn(async (_evt: unknown) => undefined);
    let won = false;
    const claim = vi.fn(async (): Promise<ClaimResult> => {
      if (!won) {
        won = true;
        return claimed();
      }
      return { ok: false, code: "not_queued", tenant_id: TENANT, exec_status: "dispatching", lease_expired: false };
    });
    const [a, b] = await Promise.all([
      runChannelActionMutation(ACTION, execDeps(send, claim)),
      runChannelActionMutation(ACTION, execDeps(send, claim)),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(a.settle).toBeNull();
    expect(b.settle).toBeNull();
    const outcomes = [a.outcome, b.outcome];
    expect(outcomes).toContainEqual({ ok: true, deferred: true });
    expect(outcomes).toContainEqual({ ok: true, skipped: "in_flight" });
  });

  it("a short wallet settles the card FAILED with the credits line and the code, and queues nothing", async () => {
    const send = vi.fn(async (_evt: unknown) => undefined);
    const out = await runChannelActionMutation(ACTION, execDeps(send, vi.fn(async () => claimed()), vi.fn(async () => "short" as const)));
    expect(send).not.toHaveBeenCalled();
    expect(out.settle).toMatchObject({ ok: false, claim_id: CLAIM, result: { code: "insufficient_credits" } });
    expect(out.settle?.error).toMatch(/^This video costs about [\d,]+ credits .*Top up credits, then press Try again\. Nothing was made and nothing was charged\.$/);
  });

  it("a disabled workspace queues nothing and settles the card FAILED with the tenant_disabled code", async () => {
    const send = vi.fn(async (_evt: unknown) => undefined);
    const out = await runChannelActionMutation(ACTION, {
      ...execDeps(send, vi.fn(async () => claimed())),
      tenantDisabled: vi.fn(async () => true),
    });
    expect(send).not.toHaveBeenCalled();
    expect(out.outcome).toEqual({ ok: false, skipped: "tenant_disabled" });
    expect(out.settle).toMatchObject({
      ok: false,
      claim_id: CLAIM,
      error: "This workspace is disabled, so Zavi did not apply this change. Nothing in the account changed.",
      result: { code: "tenant_disabled" },
    });
  });
});

describe("the Autopilot auto-approve door", () => {
  it("does not open for generated_video.render.v1", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, id: ACTION }, error: null }));
    await recordChannelExecAction(
      {
        tenantId: TENANT,
        runId: RUN,
        execClass: GENERATED_VIDEO_RENDER_CLASS,
        execPayload: { intake: INTAKE },
        actionType: "video_post",
        title: "Product demo: setup took four minutes",
        body: { step: { body: "x" } },
      },
      rpc as never,
    );
    expect(hoisted.cgoApprove).not.toHaveBeenCalled();
  });

  it("(control) still opens for an ad class, so the check above is not vacuous", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, id: ACTION }, error: null }));
    await recordChannelExecAction(
      { tenantId: TENANT, runId: RUN, execClass: "meta_ads.pause", execPayload: {}, actionType: "pause_ad", title: "Pause", body: {} },
      rpc as never,
    );
    expect(hoisted.cgoApprove).toHaveBeenCalledTimes(1);
  });
});
