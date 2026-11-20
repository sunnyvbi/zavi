import { describe, it, expect, beforeEach, vi } from "vitest";

const { innerText, locatorEvaluate, locatorClick, page, connectOverCDP } = vi.hoisted(() => {
  const innerText = vi.fn(async () => "Hello World");
  const locatorEvaluate = vi.fn(async () => false);
  const locatorClick = vi.fn(async () => {});
  const page = {
    goto: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      first: () => ({ innerText, evaluate: locatorEvaluate, click: locatorClick }),
    })),
    url: vi.fn(() => "https://example.com/dashboard"),
    screenshot: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
  };
  const ctx = { pages: () => [page], newPage: async () => page };
  const browser = {
    contexts: () => [ctx],
    newContext: async () => ctx,
    close: vi.fn(async () => {}),
  };
  const connectOverCDP = vi.fn(async () => browser);
  return { innerText, locatorEvaluate, locatorClick, page, connectOverCDP };
});
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));

import { createRestAnchorClient } from "../anchor-rest-client";
import type { AnchorSession } from "../anchor-backend";

const SESSION: AnchorSession = { id: "s1", cdp_url: "wss://anchor/s1" };

beforeEach(() => {
  innerText.mockReset().mockResolvedValue("Hello World");
  locatorEvaluate.mockReset().mockResolvedValue(false);
  locatorClick.mockReset().mockResolvedValue(undefined);
  for (const f of [
    page.goto,
    page.click,
    page.fill,
    page.screenshot,
    page.waitForSelector,
    connectOverCDP,
  ])
    (f as ReturnType<typeof vi.fn>).mockClear();
});

describe("anchor-rest-client runAction op mapping", () => {
  it("nav → page.goto(domcontentloaded)", async () => {
    const c = createRestAnchorClient();
    const r = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "nav", url: "https://instagram.com" },
    });
    expect(r.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      "https://instagram.com",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("click / fill / wait_for map to the matching page calls", async () => {
    const c = createRestAnchorClient();
    await c.runAction({ apiKey: "k", session: SESSION, op: { op: "click", selector: "#go" } });
    await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "fill", selector: "#u", value: "ravi" },
    });
    await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "wait_for", selector: "#done", timeout_ms: 1234 },
    });
    expect(page.click).toHaveBeenCalledWith("#go", expect.any(Object));
    expect(page.fill).toHaveBeenCalledWith("#u", "ravi", expect.any(Object));
    expect(page.waitForSelector).toHaveBeenCalledWith(
      "#done",
      expect.objectContaining({ timeout: 1234 }),
    );
  });

  it("fill on a contenteditable target → sets text via locator.evaluate (not page.fill)", async () => {
    locatorEvaluate.mockResolvedValueOnce(true);
    const c = createRestAnchorClient();
    const r = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "fill", selector: 'div[role="textbox"]', value: "hello world" },
    });
    expect(r.ok).toBe(true);
    expect(locatorClick).toHaveBeenCalled();
    expect(locatorEvaluate).toHaveBeenCalledTimes(2);
    expect(page.fill).not.toHaveBeenCalled();
  });

  it("text → returns innerText", async () => {
    innerText.mockResolvedValueOnce("the answer");
    const c = createRestAnchorClient();
    const r = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "text", selector: "#a" },
    });
    expect(r).toEqual({ ok: true, result: "the answer" });
  });

  it("assert_text hit vs miss", async () => {
    const c = createRestAnchorClient();
    innerText.mockResolvedValueOnce("Welcome Ravi");
    const hit = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "assert_text", selector: "#h", expected: "Ravi" },
    });
    expect(hit.ok).toBe(true);
    innerText.mockResolvedValueOnce("Welcome Ravi");
    const miss = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "assert_text", selector: "#h", expected: "Nope" },
    });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error_code).toBe("assert_text_miss");
  });

  it("assert_url substring + regex", async () => {
    const c = createRestAnchorClient();
    const sub = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "assert_url", expected: "/dashboard" },
    });
    expect(sub.ok).toBe(true);
    const rx = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "assert_url", expected: "^https://example\\.com/.*$" },
    });
    expect(rx.ok).toBe(true);
    const miss = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "assert_url", expected: "/settings" },
    });
    expect(miss.ok).toBe(false);
  });

  it("op-level failure (selector throw) → ok:false, never throws", async () => {
    page.click.mockRejectedValueOnce(new Error("Timeout 5000ms exceeded"));
    const c = createRestAnchorClient();
    const r = await c.runAction({
      apiKey: "k",
      session: SESSION,
      op: { op: "click", selector: "#missing" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("click_failed");
  });

  it("connects over CDP once per session, reused across ops", async () => {
    const c = createRestAnchorClient();
    await c.runAction({ apiKey: "k", session: SESSION, op: { op: "nav", url: "https://x.com" } });
    await c.runAction({ apiKey: "k", session: SESSION, op: { op: "click", selector: "#a" } });
    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).toHaveBeenCalledWith("wss://anchor/s1");
  });
});

describe("anchor-rest-client createSession parsing + options", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  function okResponse(json: unknown) {
    return { ok: true, status: 200, json: async () => json };
  }
  function lastPostedBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    return JSON.parse((init as RequestInit).body as string);
  }

  it("parses live_view_url from the nested { data } envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        data: {
          id: "sess-1",
          cdp_url: "wss://anchor/sess-1",
          live_view_url: "https://live.anchorbrowser.io/v/abc123",
        },
      }),
    );
    const c = createRestAnchorClient();
    const s = await c.createSession({ apiKey: "k" });
    expect(s).toEqual({
      id: "sess-1",
      cdp_url: "wss://anchor/sess-1",
      live_view_url: "https://live.anchorbrowser.io/v/abc123",
    });
  });

  it("parses live_view_url from a top-level (un-enveloped) response", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        id: "sess-2",
        cdp_url: "wss://anchor/sess-2",
        live_view_url: "https://live.anchorbrowser.io/v/def456",
      }),
    );
    const c = createRestAnchorClient();
    const s = await c.createSession({ apiKey: "k" });
    expect(s.live_view_url).toBe("https://live.anchorbrowser.io/v/def456");
  });

  it("live_view_url is undefined when absent (headless / not returned)", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ data: { id: "sess-3", cdp_url: "wss://anchor/sess-3" } }),
    );
    const c = createRestAnchorClient();
    const s = await c.createSession({ apiKey: "k" });
    expect(s.live_view_url).toBeUndefined();
  });

  it("preview path (no profileId) never sends a profile in the body", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "sess-4" } }));
    const c = createRestAnchorClient();
    await c.createSession({ apiKey: "k", headful: true, oneTimeLiveViewUrl: true });
    const body = lastPostedBody();
    expect(body.profile).toBeUndefined();
    expect(body.browser).toEqual({ headless: { active: false } });
    expect(body.session).toEqual({ live_view: { one_time_url: true } });
  });

  it("merges viewport into browser config alongside headless (preview path)", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "sess-vp" } }));
    const c = createRestAnchorClient();
    await c.createSession({
      apiKey: "k",
      headful: true,
      viewport: { width: 1600, height: 1000 },
    });
    const body = lastPostedBody();
    expect(body.browser).toEqual({
      headless: { active: false },
      viewport: { width: 1600, height: 1000 },
    });
  });

  it("social-login path still sends the profile unchanged", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "sess-5" } }));
    const c = createRestAnchorClient();
    await c.createSession({ apiKey: "k", profileId: "prof-xyz" });
    const body = lastPostedBody();
    expect(body.profile).toEqual({ id: "prof-xyz" });
    expect(body.browser).toBeUndefined();
    expect(body.session).toBeUndefined();
  });

  it("throws when the response has no session id", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: {} }));
    const c = createRestAnchorClient();
    await expect(c.createSession({ apiKey: "k" })).rejects.toThrow(/no session id/);
  });
});

describe("anchor-rest-client REST timeouts (PR #3560 F6)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("create and delete both carry an abort signal", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { id: "s9", cdp_url: "wss://x" } }) });
    const c = createRestAnchorClient();
    await c.createSession({ apiKey: "k" });
    await c.closeSession({ apiKey: "k", session: { id: "s9" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("a DELETE that times out REJECTS (never reported as a confirmed close)", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const c = createRestAnchorClient();
    await expect(c.closeSession({ apiKey: "k", session: { id: "s9" } })).rejects.toThrow(/timeout/);
  });

  it("a non-2xx DELETE rejects", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const c = createRestAnchorClient();
    await expect(c.closeSession({ apiKey: "k", session: { id: "s9" } })).rejects.toThrow(/HTTP 502/);
  });
});
