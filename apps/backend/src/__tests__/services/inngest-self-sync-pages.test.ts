import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alertMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/logging/alert", () => ({ alert: alertMock }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { selfSyncInngestOnBoot } from "../../services/inngest-self-sync";

describe("boot self-sync failure pages", () => {
  const prev = process.env.INNGEST_SELF_SYNC_URL;
  beforeEach(() => {
    alertMock.mockReset();
    process.env.INNGEST_SELF_SYNC_URL = "https://jobs.zaviagent.com/api/inngest";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.INNGEST_SELF_SYNC_URL;
    else process.env.INNGEST_SELF_SYNC_URL = prev;
  });

  it("calls alert() with an email page after every attempt fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    const r = await selfSyncInngestOnBoot(4000, {
      fetchFn: fetchFn as never,
      sleepFn: async () => undefined,
      signingKey: "signkey-test",
    });
    expect(r.ok).toBe(false);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const arg = alertMock.mock.calls[0][0];
    expect(arg.code).toBe("inngest.self_sync.failed");
    expect(arg.email.dedupeKey).toMatch(/^inngest-self-sync:https:\/\/jobs\.zaviagent\.com\/api\/inngest:\d+$/);
  });

  it("does not page on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await selfSyncInngestOnBoot(4000, {
      fetchFn: fetchFn as never,
      sleepFn: async () => undefined,
      signingKey: "signkey-test",
    });
    expect(alertMock).not.toHaveBeenCalled();
  });
});
