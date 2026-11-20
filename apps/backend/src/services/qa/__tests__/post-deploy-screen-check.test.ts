import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const guard = vi.hoisted(() => ({ assertSafeUrl: vi.fn(async (u: string) => new URL(u)) }));
vi.mock("@/services/onboarding/enrichment/url-guard", () => guard);

import { runPostDeployScreenCheck } from "../post-deploy-screen-check";
import { createAnchorChromiumLauncher } from "../anchor-launcher";
import type { ChromiumLauncher, ShowabilityResult } from "../showability-gate";
import type { AnchorClient } from "@/services/sandbox/browser-mcp/anchor-backend";

const NOW = () => new Date("2026-09-26T12:00:00Z");
const fakeLauncher = {} as ChromiumLauncher;

function result(over: Partial<ShowabilityResult> = {}): ShowabilityResult {
  return {
    pass: true,
    url: "https://acme.onrender.com",
    snapshots: [
      { viewport: "desktop", path: "/", status: 200, consoleErrors: ["x 404"], pageErrors: [], loadErr: null, checks: null },
    ],
    fails: [],
    firstFailure: "",
    fontWarnings: [],
    ...over,
  };
}

const SAVED_KEY = process.env.ANCHOR_API_KEY;
beforeEach(() => {
  guard.assertSafeUrl.mockClear();
});
afterEach(() => {
  if (SAVED_KEY === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = SAVED_KEY;
});

describe("runPostDeployScreenCheck", () => {
  it("skips when there is no live url", async () => {
    const r = await runPostDeployScreenCheck({ url: null }, { now: NOW });
    expect(r).toMatchObject({ status: "skipped", reason: "no live url" });
  });

  it("skips with a reason when ANCHOR_API_KEY is missing (no browser opened)", async () => {
    delete process.env.ANCHOR_API_KEY;
    const run = vi.fn();
    const r = await runPostDeployScreenCheck({ url: "https://acme.onrender.com" }, { run, now: NOW });
    expect(r).toMatchObject({ status: "skipped", reason: "ANCHOR_API_KEY not set" });
    expect(run).not.toHaveBeenCalled();
  });

  it("upgrades http to https before the SSRF guard and runs '/' only", async () => {
    const run = vi.fn(async () => result());
    const r = await runPostDeployScreenCheck(
      { url: "http://acme.onrender.com" },
      { launcher: fakeLauncher, run, now: NOW },
    );
    expect(guard.assertSafeUrl).toHaveBeenCalledWith("https://acme.onrender.com");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://acme.onrender.com", paths: ["/"] }),
      fakeLauncher,
    );
    expect(r).toEqual({
      status: "pass",
      checked_at: "2026-09-26T12:00:00.000Z",
      url: "https://acme.onrender.com",
      fails: [],
      font_warnings: [],
      console_errors: ["x 404"],
    });
  });

  it("records a fail verdict with its findings", async () => {
    const run = vi.fn(async () =>
      result({ pass: false, fails: ["[mobile/] horizontal overflow 600>375"] }),
    );
    const r = await runPostDeployScreenCheck({ url: "https://a.b" }, { launcher: fakeLauncher, run, now: NOW });
    expect(r.status).toBe("fail");
    expect(r.fails).toEqual(["[mobile/] horizontal overflow 600>375"]);
  });

  it("skips when the SSRF guard rejects the url", async () => {
    guard.assertSafeUrl.mockRejectedValueOnce(new Error("resolves to blocked IP"));
    const run = vi.fn();
    const r = await runPostDeployScreenCheck({ url: "https://internal.example" }, { launcher: fakeLauncher, run });
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("unsafe url");
    expect(run).not.toHaveBeenCalled();
  });

  it("an Anchor/connect throw is recorded as skipped, never a fail", async () => {
    const run = vi.fn(async () => {
      throw new Error("anchor session create failed: 401");
    });
    const r = await runPostDeployScreenCheck({ url: "https://a.b" }, { launcher: fakeLauncher, run });
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("401");
  });

  it("every render failing to load is treated as our browser, recorded skipped", async () => {
    const run = vi.fn(async () =>
      result({
        pass: false,
        fails: ["load failed"],
        snapshots: [
          { viewport: "desktop", path: "/", status: 0, consoleErrors: [], pageErrors: [], loadErr: "net::ERR", checks: null },
          { viewport: "mobile", path: "/", status: 0, consoleErrors: [], pageErrors: [], loadErr: "net::ERR", checks: null },
        ],
      }),
    );
    const r = await runPostDeployScreenCheck({ url: "https://a.b" }, { launcher: fakeLauncher, run });
    expect(r.status).toBe("skipped");
  });

  it("times out as skipped", async () => {
    const run = vi.fn(() => new Promise<ShowabilityResult>(() => {}));
    const r = await runPostDeployScreenCheck(
      { url: "https://a.b" },
      { launcher: fakeLauncher, run, timeoutMs: 5 },
    );
    expect(r).toMatchObject({ status: "skipped", reason: "timed out" });
  });
});

describe("createAnchorChromiumLauncher", () => {
  function client(over: Partial<AnchorClient> = {}): AnchorClient {
    return {
      createSession: vi.fn(async () => ({ id: "s1", cdp_url: "wss://anchor/cdp" })),
      runAction: vi.fn(),
      closeSession: vi.fn(async () => {}),
      ...over,
    } as unknown as AnchorClient;
  }

  it("closes the Anchor session when CDP connect fails", async () => {
    const c = client();
    const launcher = createAnchorChromiumLauncher({
      apiKey: "k",
      client: c,
      connect: vi.fn(async () => {
        throw new Error("connect timeout");
      }),
    });
    await expect(launcher.launch({ headless: true })).rejects.toThrow("connect timeout");
    expect(c.closeSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a session without a cdp_url and closes it", async () => {
    const c = client({ createSession: vi.fn(async () => ({ id: "s1" })) as AnchorClient["createSession"] });
    const connect = vi.fn();
    const launcher = createAnchorChromiumLauncher({ apiKey: "k", client: c, connect });
    await expect(launcher.launch({ headless: true })).rejects.toThrow("cdp_url");
    expect(connect).not.toHaveBeenCalled();
    expect(c.closeSession).toHaveBeenCalledTimes(1);
  });

  it("browser.close() closes both the CDP browser and the Anchor session", async () => {
    const c = client();
    const browserClose = vi.fn(async () => {});
    const launcher = createAnchorChromiumLauncher({
      apiKey: "k",
      client: c,
      connect: vi.fn(async () => ({ close: browserClose, contexts: () => [] }) as never),
    });
    const b = await launcher.launch({ headless: true });
    await b.close();
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(c.closeSession).toHaveBeenCalledWith({ apiKey: "k", session: { id: "s1", cdp_url: "wss://anchor/cdp" } });
  });
  it("registers the session for the stale-session reaper and closes the row on close and on connect failure", async () => {
    for (const failConnect of [false, true]) {
      const c = client();
      const tracker = {
        open: vi.fn(async () => "row-1"),
        setProviderId: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      const connect = failConnect
        ? vi.fn(async () => {
            throw new Error("connect timeout");
          })
        : vi.fn(async () => ({ close: vi.fn(async () => {}), contexts: () => [] }) as never);
      const launcher = createAnchorChromiumLauncher({ apiKey: "k", client: c, connect, tenantId: "t-1", tracker });
      if (failConnect) await expect(launcher.launch({ headless: true })).rejects.toThrow("connect timeout");
      else await (await launcher.launch({ headless: true })).close();
      expect(tracker.open).toHaveBeenCalledWith({ tenant_id: "t-1", run_id: null, origin: "screen_check" });
      expect(tracker.setProviderId).toHaveBeenCalledWith({ session_id: "row-1", provider_session_id: "s1" });
      expect(c.closeSession).toHaveBeenCalledTimes(1);
      expect(tracker.close).toHaveBeenCalledWith({ session_id: "row-1", reason: "screen_check_done" });
    }
  });

  it("a hung browser.close() cannot hold back the Anchor DELETE", async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const launcher = createAnchorChromiumLauncher({
        apiKey: "k",
        client: c,
        connect: vi.fn(async () => ({ close: () => new Promise(() => {}), contexts: () => [] }) as never),
      });
      const b = await launcher.launch({ headless: true });
      const closing = b.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      expect(c.closeSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a failed provider-id stamp aborts the launch and DELETEs the session now (never left unreapable)", async () => {
    const c = client();
    const connect = vi.fn();
    const tracker = {
      open: vi.fn(async () => "row-1"),
      setProviderId: vi.fn(async () => {
        throw new Error("rpc down");
      }),
      close: vi.fn(async () => {}),
    };
    const launcher = createAnchorChromiumLauncher({ apiKey: "k", client: c, connect, tenantId: "t-1", tracker });
    await expect(launcher.launch({ headless: true })).rejects.toThrow("rpc down");
    expect(connect).not.toHaveBeenCalled();
    expect(c.closeSession).toHaveBeenCalledTimes(1);
    expect(tracker.close).toHaveBeenCalledWith({ session_id: "row-1", reason: "screen_check_done" });
  });
});
