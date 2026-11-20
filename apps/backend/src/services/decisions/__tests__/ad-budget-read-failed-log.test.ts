import { describe, it, expect, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/logging/logEvent", () => ({ logEvent, LOG_META_KEYS: [] }));

import { logReadFailed } from "../ad-budget-reconcile";

describe("logReadFailed", () => {
  it("must catch: the platform and its error reach praxis_logs, a token never does", async () => {
    await logReadFailed("t1", "linkedin", new Error('LinkedIn Ads period spend is missing; access_token="AQVabcdefghijklmnopqrstuvwxyz0123456789"'));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "ad_budget_read_failed", tenant_id: "t1", meta: { platform: "linkedin" } }));
    const msg = (logEvent.mock.calls[0] as unknown as [{ message: string }])[0].message;
    expect(msg).toContain("linkedin: LinkedIn Ads period spend is missing");
    expect(msg).not.toContain("AQVabcdefghijklmnop");
  });
  it("never throws when logging fails", async () => {
    logEvent.mockRejectedValueOnce(new Error("db down"));
    await expect(logReadFailed("t1", "x", new Error("boom"))).resolves.toBeUndefined();
  });
});
