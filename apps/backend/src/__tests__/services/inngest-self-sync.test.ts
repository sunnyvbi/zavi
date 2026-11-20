import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

import { selfSyncInngestOnBoot } from "@/services/inngest-self-sync";

const PORT = 4000;
const noSleep = () => Promise.resolve();

function okResp(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe("selfSyncInngestOnBoot", () => {
  it("skips when no signing key (local dev → Inngest dev server)", async () => {
    const fetchFn = vi.fn();
    const logFn = vi.fn().mockResolvedValue(undefined);
    const r = await selfSyncInngestOnBoot(PORT, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      logFn: logFn as never,
      signingKey: undefined,
    });
    expect(r).toEqual({ ok: true, attempts: 0, skipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logFn).not.toHaveBeenCalled();
  });

  it("PUTs the local /api/inngest WITHOUT an auth header and succeeds on first try", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp(200));
    const logFn = vi.fn().mockResolvedValue(undefined);
    const r = await selfSyncInngestOnBoot(PORT, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      logFn: logFn as never,
      signingKey: "signkey-123",
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`http://localhost:${PORT}/api/inngest`);
    expect(init.method).toBe("PUT");
    expect(init.headers?.Authorization).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logFn).not.toHaveBeenCalled();
  });

  it("uses the public API origin in production so Inngest does not register localhost URLs", async () => {
    const oldNodeEnv = process.env.NODE_ENV;
    const oldIssuer = process.env.PRAXIS_ISSUER_URL;
    process.env.NODE_ENV = "production";
    process.env.PRAXIS_ISSUER_URL = "https://api.zaviagent.com";
    try {
      const fetchFn = vi.fn().mockResolvedValue(okResp(200));
      const logFn = vi.fn().mockResolvedValue(undefined);
      const r = await selfSyncInngestOnBoot(PORT, {
        fetchFn: fetchFn as unknown as typeof fetch,
        sleepFn: noSleep,
        logFn: logFn as never,
        signingKey: "signkey-123",
      });
      expect(r.ok).toBe(true);
      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.zaviagent.com/api/inngest");
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      if (oldIssuer === undefined) delete process.env.PRAXIS_ISSUER_URL;
      else process.env.PRAXIS_ISSUER_URL = oldIssuer;
    }
  });

  it("retries on a transient failure then succeeds (no error log)", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(okResp(200))
      .mockResolvedValueOnce(okResp(200));
    const logFn = vi.fn().mockResolvedValue(undefined);
    const r = await selfSyncInngestOnBoot(PORT, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      logFn: logFn as never,
      signingKey: "k",
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(logFn).not.toHaveBeenCalled();
  });

  it("emits a loud error log after exhausting all attempts (deafness made visible)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp(500));
    const logFn = vi.fn().mockResolvedValue(undefined);
    const r = await selfSyncInngestOnBoot(PORT, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      logFn: logFn as never,
      signingKey: "k",
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(4);
    expect(logFn).toHaveBeenCalledTimes(1);
    const arg = logFn.mock.calls[0][0];
    expect(arg.level).toBe("error");
    expect(arg.source).toBe("inngest-self-sync");
    expect(arg.code).toBe("inngest.self_sync.failed");
  });

  it("the failure alert names the URL this host syncs, not a hard-coded API host", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResp(500));
    const logFn = vi.fn().mockResolvedValue(undefined);
    await selfSyncInngestOnBoot(PORT, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      logFn: logFn as never,
      signingKey: "k",
      syncUrl: "https://jobs.zaviagent.com/api/inngest",
    });
    expect(logFn.mock.calls[0][0].message).toContain("curl -X PUT https://jobs.zaviagent.com/api/inngest");
  });

  it("never throws even if every PUT rejects (fire-and-forget contract)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const logFn = vi.fn().mockResolvedValue(undefined);
    await expect(
      selfSyncInngestOnBoot(PORT, {
        fetchFn: fetchFn as unknown as typeof fetch,
        sleepFn: noSleep,
        logFn: logFn as never,
        signingKey: "k",
      }),
    ).resolves.toEqual({ ok: false, attempts: 4 });
    expect(logFn).toHaveBeenCalledTimes(1);
  });
});
