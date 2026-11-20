import { describe, it, expect, vi } from "vitest";
import { createAnchorChromiumLauncher } from "../anchor-launcher";

function harness(deleteOk: boolean) {
  const closeRow = vi.fn(async () => undefined);
  const closeSession = vi.fn(async () => {
    if (!deleteOk) throw new Error("anchor delete-session: HTTP 500");
  });
  const launcher = createAnchorChromiumLauncher({
    apiKey: "k",
    tenantId: "t1",
    client: {
      createSession: async () => ({ id: "s1", cdp_url: "wss://x" }),
      closeSession,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connect: async () => ({ close: async () => undefined, contexts: () => [] }) as any,
    tracker: {
      open: async () => "row1",
      setProviderId: async () => undefined,
      close: closeRow,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
  return { launcher, closeRow, closeSession };
}

describe("createAnchorChromiumLauncher close", () => {
  it("closes the registry row after a successful DELETE", async () => {
    const h = harness(true);
    const browser = await h.launcher.launch({ headless: true });
    await browser.close();
    expect(h.closeSession).toHaveBeenCalledTimes(1);
    expect(h.closeRow).toHaveBeenCalledTimes(1);
  });

  it("leaves the row open when the DELETE fails, so the stale-session reaper retries it", async () => {
    const h = harness(false);
    const browser = await h.launcher.launch({ headless: true });
    await expect(browser.close()).resolves.toBeUndefined();
    expect(h.closeSession).toHaveBeenCalledTimes(1);
    expect(h.closeRow).not.toHaveBeenCalled();
  });
});
