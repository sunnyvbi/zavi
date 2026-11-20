import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ door: vi.fn(), cgo: vi.fn(async () => false) }));
vi.mock("@/services/approvals/envelope-door", async (orig) => ({
  ...(await orig<typeof import("@/services/approvals/envelope-door")>()),
  envelopeDoor: (...a: unknown[]) => m.door(...a),
}));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: (...a: unknown[]) => m.cgo(...(a as [])) }));

import { recordChannelExecAction } from "../exec-actions";

const input = {
  tenantId: "t-1",
  runId: "r-1",
  channelSlug: "chatgpt_ads",
  execClass: "chatgpt_ads.create_and_launch",
  execPayload: { bundle: { campaign: { name: "Founder ask" } }, currency: "USD" },
  actionType: "create_ad" as const,
  title: "Create and launch Founder ask",
  body: {},
};
const rpc = vi.fn(async () => ({ data: { ok: true, id: "new-1", replayed: false }, error: null }));
const deps = { loadPool: vi.fn(async () => []), enabled: () => true, log: vi.fn(async () => undefined) as never };

beforeEach(() => {
  m.door.mockReset();
  m.cgo.mockClear();
});

describe("recordChannelExecAction after the envelope door", () => {
  it.each(["supersede_failed", "supersede_duplicate_in_flight", "supersede_not_found"])("%s: the cgo door never runs", async (reason) => {
    m.door.mockResolvedValue({ approved: false, reason });
    expect(await recordChannelExecAction(input as never, rpc as never, deps as never)).toEqual({ id: "new-1", replayed: false });
    expect(m.cgo).not.toHaveBeenCalled();
  });
  it("any other refusal (no ask): the cgo door runs as before", async () => {
    m.door.mockResolvedValue({ approved: false, reason: "no_envelope" });
    await recordChannelExecAction(input as never, rpc as never, deps as never);
    expect(m.cgo).toHaveBeenCalledWith("t-1", "new-1");
  });
});
