import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: vi.fn(), tenantClient: vi.fn() }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, comingSoonMessage: (n: string) => n }));
const claim = vi.fn();
vi.mock("@/services/channels/claim", () => ({
  claimChannelRun: (...a: unknown[]) => claim(...a),
  settleChannelRunClaim: vi.fn(),
  releaseChannelRunClaim: vi.fn(),
}));

import { runChannelRecipe } from "@/services/channels/engine";
import { RETIRED_CHANNEL_MESSAGE } from "@zavi/shared";

describe("runChannelRecipe on a retired channel", () => {
  it("refuses blog before any claim or enqueue", async () => {
    const enqueue = vi.fn();
    const r = await runChannelRecipe("t1", "blog", { enqueue });
    expect(r).toEqual({ ok: false, reason: "retired", message: RETIRED_CHANNEL_MESSAGE });
    expect(claim).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a redo of an old blog card the same way", async () => {
    const enqueue = vi.fn();
    const r = await runChannelRecipe("t1", "blog", { enqueue }, { action_key: "a", action_title: "t", note: "n", redo_of_action_id: "a" });
    expect(r.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});
