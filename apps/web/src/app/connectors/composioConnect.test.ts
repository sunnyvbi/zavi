// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ confirm: vi.fn(), fetch: vi.fn(), ask: vi.fn(), stored: { current: null as string | null }, reads: { n: 0 } }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: m.confirm }));
vi.mock("./connectFieldPrompt", () => ({ askConnectField: m.ask }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "t1" }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => {
        m.reads.n += 1;
        return { data: m.stored.current === null ? null : { team_id: m.stored.current }, error: null };
      },
    };
    return { from: () => q };
  },
}));

import { CONNECT_RETURN_KEY, returnFromConnect, takeConnectReturn } from "./ConnectButton";
import { COMPOSIO_DONE_CHANNEL, COMPOSIO_WATCH_LIMIT_MS, COMPOSIO_WATCH_MS, startComposioConnect, watchComposioConnect } from "./composioConnect";

describe("startComposioConnect", () => {
  beforeEach(() => {
    sessionStorage.clear();
    m.confirm.mockReset();
    m.fetch.mockReset();
    m.ask.mockReset();
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=reddit_ads");
  });

  it("tells the founder to tick the product's box before leaving for Google, and only for Google", async () => {
    m.confirm.mockResolvedValue(false);
    await startComposioConnect("google_analytics");
    expect(m.confirm.mock.calls[0]![0].description).toContain("tick the Google Analytics box");
    await startComposioConnect("google_search_console");
    expect(m.confirm.mock.calls[1]![0].description).toContain("tick the Search Console box");
    await startComposioConnect("reddit_ads");
    expect(m.confirm.mock.calls[2]![0].description).not.toContain("tick");
  });

  it("a failed Google connect's Back link returns to the page Connect was clicked on, reason kept", () => {
    sessionStorage.setItem(CONNECT_RETURN_KEY, "/workspace?tab=channels&channel=seo");
    const back = takeConnectReturn("?tab=settings&composio_error=google_analytics&code=google_scope_missing");
    expect(back).toContain("composio_error=google_analytics");
    expect(back).toContain("code=google_scope_missing");
    expect(back).not.toContain("tab=settings");
    expect(takeConnectReturn("?tab=settings")).toBeNull();
  });

  it("asks in the in-app dialog and does nothing on cancel", async () => {
    m.confirm.mockResolvedValue(false);
    await startComposioConnect("reddit_ads");
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.fetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("remembers the channel page so the OAuth landing returns there", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    await startComposioConnect("reddit_ads");
    expect(takeConnectReturn("?tab=settings&composio_reddit_ads=connected")).toBe(
      "/workspace?tab=channels&channel=reddit_ads&composio_reddit_ads=connected",
    );
  });

  it("a failed start remembers nothing", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 502, ok: false, json: async () => ({}) });
    await expect(startComposioConnect("reddit_ads")).rejects.toThrow();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("a 500 with no body throws the founder sentence, never the HTTP status", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 500, ok: false, json: async () => Promise.reject(new SyntaxError("Unexpected end of JSON input")) });
    const err = await startComposioConnect("mailchimp").then(() => null, (e: Error) => e);
    expect(err?.message).toBe("Could not start the connection. Try again.");
    expect(err?.message).not.toMatch(/HTTP|500/);
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("an error with a blank message, or a 200 without an oauth_url, also throws the founder sentence", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValueOnce({ status: 503, ok: false, json: async () => ({ error: { code: "upstream", message: "  " } }) });
    await expect(startComposioConnect("klaviyo")).rejects.toThrow(/^Could not start the connection\. Try again\.$/);
    m.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({}) });
    await expect(startComposioConnect("gmail")).rejects.toThrow(/^Could not start the connection\. Try again\.$/);
  });

  it("a 400 with a JSON message keeps the server's own message", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 400, ok: false, json: async () => ({ error: { code: "not_enabled", message: "Klaviyo is not available on your plan." } }) });
    await expect(startComposioConnect("klaviyo")).rejects.toThrow(/^Klaviyo is not available on your plan\.$/);
  });

  it("asks for the store name the server names and connects again with it", async () => {
    m.confirm.mockResolvedValue(true);
    const field = { key: "subdomain", label: "Store name", placeholder: "acme", hint: "" };
    m.fetch.mockResolvedValueOnce({ status: 400, ok: false, json: async () => ({ error: { code: "connection_data_required", message: "Enter your store name to connect.", field } }) });
    m.ask.mockResolvedValue("zavi-test-store");
    m.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    await startComposioConnect("shopify");
    expect(m.ask).toHaveBeenCalledWith("Shopify", field);
    expect(JSON.parse(m.fetch.mock.calls[1][1].body)).toEqual({ connection_data: { subdomain: "zavi-test-store" }, return_to: "/workspace?tab=channels&channel=reddit_ads" });
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).not.toBeNull();
  });

  it("cancelling the store name prompt connects nothing and throws nothing", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValueOnce({ status: 400, ok: false, json: async () => ({ error: { code: "connection_data_required", field: { key: "subdomain", label: "Store name", placeholder: "", hint: "" } } }) });
    m.ask.mockResolvedValue(null);
    await startComposioConnect("shopify");
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("a composio_error landing clears the remembered page and opens Connectors", () => {
    sessionStorage.setItem(CONNECT_RETURN_KEY, "/workspace?tab=channels&channel=reddit_ads");
    expect(takeConnectReturn("?tab=settings&composio_error=reddit_ads&code=invalid_state")).toBe(
      "/workspace?tab=brain&composio_error=reddit_ads&code=invalid_state#integrations",
    );
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });
  for (const tool of ["klaviyo", "mailchimp", "gmail", "pinterest"]) {
    it(`${tool}: a connect started on Email campaigns asks the server to return to that page`, async () => {
      window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
      m.confirm.mockResolvedValue(true);
      m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
      await startComposioConnect(tool);
      expect(m.fetch).toHaveBeenCalledOnce();
      const [url, init] = m.fetch.mock.calls[0] as [string, { method: string; body?: string }];
      expect(url).toBe(`/api/connectors/composio/${tool}/connect`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body ?? "{}")).toEqual({ return_to: "/workspace?tab=channels&channel=email_marketing" });
    });
  }

  it("a connect started on Settings sends no return_to, so the server keeps its default", async () => {
    window.history.replaceState(null, "", "/workspace?tab=settings");
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    await startComposioConnect("klaviyo");
    const [, init] = m.fetch.mock.calls[0] as [string, { body?: string }];
    expect(init.body).toBeUndefined();
  });

  it("landing straight on the started page with the connected flag stays there", async () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    await startComposioConnect("klaviyo");
    expect(takeConnectReturn("?tab=channels&channel=email_marketing&composio_klaviyo=connected")).toBeNull();
    expect(takeConnectReturn("?tab=settings&composio_error=klaviyo&code=invalid_state")).toBe(
      "/workspace?tab=brain&composio_error=klaviyo&code=invalid_state#integrations",
    );
  });

  it("a direct landing drops the Settings fallback, so a later native connect from Settings stays on Settings", async () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    await startComposioConnect("klaviyo");
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).not.toBeNull();
    expect(takeConnectReturn("?tab=channels&channel=email_marketing&composio_klaviyo=connected")).toBeNull();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
    expect(takeConnectReturn("?tab=settings&github=connected")).toBe("/workspace?tab=brain&github=connected#integrations");
  });
  it("a connect started on Settings after an Email campaigns connect landed directly stays on Settings", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth" }) });
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
    await startComposioConnect("klaviyo");
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing&composio_klaviyo=connected");
    expect(returnFromConnect()).toBe(false);

    window.history.replaceState(null, "", "/workspace?tab=settings");
    await startComposioConnect("mailchimp");
    window.history.replaceState(null, "", "/workspace?tab=settings&composio_mailchimp=connected");
    returnFromConnect();
    expect(window.location.pathname + window.location.search).toBe("/workspace?tab=settings&composio_mailchimp=connected");
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });
});

function fakeTab() {
  const tab = { closed: false, opener: window as unknown, location: { href: "" }, close: vi.fn(() => { tab.closed = true; }) };
  return tab;
}

describe("Composio link in its own tab", () => {
  let replaced: string[];
  beforeEach(() => {
    sessionStorage.clear();
    m.confirm.mockReset();
    m.fetch.mockReset();
    m.stored.current = null;
    m.reads.n = 0;
    replaced = [];
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=pinterest_organic");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubReplace() {
    const loc = window.location;
    vi.stubGlobal("location", { ...loc, href: loc.href, pathname: loc.pathname, search: loc.search, hash: loc.hash, replace: (u: string) => replaced.push(u) });
  }

  it("keeps this tab, and once the new account is stored closes the tab it opened and returns the founder to where they started", async () => {
    const tab = fakeTab();
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "https://dashboard.composio.dev/link/lk_1", connected_account_id: "ca_new" }) });
    const startHref = window.location.href;
    await startComposioConnect("pinterest");
    stubReplace();
    expect(open).toHaveBeenCalledOnce();
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe("https://dashboard.composio.dev/link/lk_1");
    expect(window.location.href).toBe(startHref);

    m.stored.current = "ca_old";
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_MS * 3);
    expect(m.reads.n).toBeGreaterThanOrEqual(2);
    expect(tab.close).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);

    m.stored.current = "ca_new";
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_MS);
    expect(tab.close).toHaveBeenCalledOnce();
    expect(replaced).toEqual(["/workspace?tab=channels&channel=pinterest_organic&composio_pinterest=connected"]);
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();

    const reads = m.reads.n;
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_MS * 5);
    expect(m.reads.n).toBe(reads);
    expect(replaced).toHaveLength(1);
  });

  it("notices the connection as soon as the founder comes back to this tab", async () => {
    stubReplace();
    const tab = fakeTab();
    const done = watchComposioConnect("pinterest", "ca_new", tab as unknown as Window);
    m.stored.current = "ca_new";
    window.dispatchEvent(new Event("focus"));
    await expect(done).resolves.toBe(true);
    expect(tab.close).toHaveBeenCalledOnce();
    expect(replaced).toHaveLength(1);
  });

  it("does not close a tab the founder already closed, and gives up after the connect window", async () => {
    stubReplace();
    const tab = fakeTab();
    tab.closed = true;
    const done = watchComposioConnect("pinterest", "ca_new", tab as unknown as Window);
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_LIMIT_MS + COMPOSIO_WATCH_MS);
    await expect(done).resolves.toBe(false);
    m.stored.current = "ca_new";
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_MS * 3);
    expect(tab.close).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });

  it("closes the tab it opened when the start fails", async () => {
    const tab = fakeTab();
    vi.stubGlobal("open", vi.fn(() => tab));
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 502, ok: false, json: async () => ({ error: { message: "nope" } }) });
    await expect(startComposioConnect("pinterest")).rejects.toThrow("nope");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("uses this tab when the browser blocks the new one, and for Google Analytics whose return asks for a property", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth", connected_account_id: "ca_new" }) });
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    await startComposioConnect("pinterest");
    expect(window.location.hash).toBe("#oauth");

    window.history.replaceState(null, "", "/workspace?tab=channels&channel=seo");
    const ga = vi.fn(() => fakeTab());
    vi.stubGlobal("open", ga);
    await startComposioConnect("google_analytics");
    expect(ga).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#oauth");
    expect(m.reads.n).toBe(0);
  });

  it("asks the backend for the small done page only when it really opened a new tab", async () => {
    m.confirm.mockResolvedValue(true);
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "#oauth", connected_account_id: "ca_new" }) });
    vi.stubGlobal("open", vi.fn(() => fakeTab()));
    await startComposioConnect("pinterest");
    expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toMatchObject({ popup: true });

    vi.stubGlobal("open", vi.fn(() => null));
    await startComposioConnect("pinterest");
    expect(JSON.parse(m.fetch.mock.calls[1][1].body)).not.toHaveProperty("popup");

    const ga = vi.fn(() => fakeTab());
    vi.stubGlobal("open", ga);
    await startComposioConnect("google_analytics");
    expect(ga).not.toHaveBeenCalled();
    expect(JSON.parse(m.fetch.mock.calls[2][1].body)).not.toHaveProperty("popup");
  });

  it("stops waiting quietly when the new tab reports a failed connect for this app, and ignores other apps", async () => {
    stubReplace();
    const tab = fakeTab();
    let settled: boolean | null = null;
    void watchComposioConnect("pinterest", "ca_new", tab as unknown as Window).then((v) => { settled = v; });
    const ch = new BroadcastChannel(COMPOSIO_DONE_CHANNEL);
    ch.postMessage({ toolkit: "reddit_ads", status: "error" });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBeNull();

    ch.postMessage({ toolkit: "pinterest", status: "error" });
    await new Promise((r) => setTimeout(r, 20));
    ch.close();
    expect(settled).toBe(false);
    const reads = m.reads.n;
    m.stored.current = "ca_new";
    await vi.advanceTimersByTimeAsync(COMPOSIO_WATCH_MS * 5);
    window.dispatchEvent(new Event("focus"));
    expect(m.reads.n).toBe(reads);
    expect(tab.close).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });

  it("checks at once when the new tab reports the app connected, without waiting for the next poll", async () => {
    stubReplace();
    const tab = fakeTab();
    const done = watchComposioConnect("pinterest", "ca_new", tab as unknown as Window);
    m.stored.current = "ca_new";
    const ch = new BroadcastChannel(COMPOSIO_DONE_CHANNEL);
    ch.postMessage({ toolkit: "pinterest", status: "connected" });
    await expect(done).resolves.toBe(true);
    ch.close();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toContain("composio_pinterest=connected");
  });
});
