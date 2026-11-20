import { describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import { durableStep, requestHash } from "./operations";
import { memoryStore } from "./memory-store.test-support";
import { runWithWriteFence } from "@/services/channels/write-fence";

describe("durable Reddit steps", () => {
  it("reuses completed IDs across duplicate dispatch and restart", async () => {
    const store = memoryStore();
    const create = vi.fn().mockResolvedValue({ id: "campaign_1" });
    const reconcile = vi.fn();
    await durableStep(store, "campaign", { name: "test" }, create, reconcile);
    expect(await durableStep({ ...store }, "campaign", { name: "test" }, create, reconcile)).toEqual({ id: "campaign_1" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("counts a step an earlier attempt owns as a possible write", async () => {
    const store = memoryStore();
    await durableStep(store, "campaign", { name: "test" }, async () => ({ id: "campaign_1" }), async () => null);
    const fence = { wrote: false };
    await runWithWriteFence(fence, () => durableStep(store, "campaign", { name: "test" }, vi.fn(), vi.fn()));
    expect(fence.wrote).toBe(true);
  });
  it("persists uncertainty and never repeats a timed-out create", async () => {
    const store = memoryStore();
    const create = vi.fn().mockRejectedValue(new ExpectedToolError("reddit_ads_outcome_unknown", "timeout"));
    await expect(durableStep(store, "campaign", {}, create, async () => null)).rejects.toThrow("timeout");
    expect(store.rows.get("campaign")?.state).toBe("unknown");
    await expect(durableStep(store, "campaign", {}, create, async () => null)).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await durableStep(store, "campaign", {}, create, async () => ({ id: "recovered" }))).toEqual({ id: "recovered" });
  });
  it("allows a known refusal to be retried with the original request", async () => {
    const store = memoryStore();
    const create = vi.fn().mockRejectedValueOnce(new ExpectedToolError("reddit_ads_permission_denied", "denied")).mockResolvedValue({ id: "ok" });
    await expect(durableStep(store, "group", {}, create, async () => null)).rejects.toThrow("denied");
    expect(await durableStep(store, "group", {}, create, async () => null)).toEqual({ id: "ok" });
  });
  it("rejects changed settings under an existing key", async () => {
    const store = memoryStore();
    await durableStep(store, "ad", { name: "original" }, async () => ({ id: "ad" }), async () => null);
    await expect(durableStep(store, "ad", { name: "changed" }, vi.fn(), async () => null)).rejects.toMatchObject({ code: "reddit_ads_operation_conflict" });
    expect(requestHash({ b: 2, a: { y: 2, x: 1 } })).toBe(requestHash({ a: { x: 1, y: 2 }, b: 2 }));
  });
  it("does not create over an in-flight concurrent claim", async () => {
    const store = memoryStore();
    await store.claim("ad", {});
    const create = vi.fn();
    await expect(durableStep(store, "ad", {}, create, async () => null)).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    expect(create).not.toHaveBeenCalled();
  });
});
