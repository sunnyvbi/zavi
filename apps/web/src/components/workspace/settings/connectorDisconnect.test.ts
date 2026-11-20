import { describe, it, expect, beforeEach, vi } from "vitest";

const { apiFetch, showConnectorError, confirmAction, clearChannelReadCache } = vi.hoisted(() => ({
  clearChannelReadCache: vi.fn(),
  apiFetch: vi.fn(),
  showConnectorError: vi.fn(),
  confirmAction: vi.fn(async (..._a: unknown[]) => true),
}));

vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./connectorErrorDialog", () => ({ showConnectorError }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction }));
vi.mock("@/lib/workspace/channelReadCache", () => ({ clearChannelReadCache }));

import { CONNECTOR_DISCONNECT, canDisconnect, disconnectConnector } from "./connectorDisconnect";

const reload = vi.fn();

beforeEach(() => {
  apiFetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  showConnectorError.mockReset();
  confirmAction.mockReset().mockResolvedValue(true);
  reload.mockReset();
  clearChannelReadCache.mockReset();
  vi.stubGlobal("window", { location: { reload } });
});

describe("canDisconnect", () => {
  it("covers X and leaves connectors with no teardown endpoint out", () => {
    expect(canDisconnect("x_social")).toBe(true);
    expect(canDisconnect("x_ads")).toBe(true);
    expect(canDisconnect("linear")).toBe(false);
  });

  it("uses the slug itself as the X endpoint path", () => {
    expect(CONNECTOR_DISCONNECT.x_social.path).toBe("x_social");
  });
});

describe("disconnectConnector", () => {
  it("asks for confirmation in the in-app dialog, not window.confirm", async () => {
    await disconnectConnector("x_social", "X (Twitter)");
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Disconnect X?",
      description: CONNECTOR_DISCONNECT.x_social.description,
      confirmLabel: "Disconnect",
      tone: "danger",
    });
  });

  it("posts to the connector's disconnect endpoint and reloads", async () => {
    await disconnectConnector("x_social", "X (Twitter)");
    expect(apiFetch).toHaveBeenCalledWith("/api/connectors/x_social/disconnect", {
      method: "POST",
    });
    expect(reload).toHaveBeenCalled();
    expect(showConnectorError).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is dismissed", async () => {
    confirmAction.mockResolvedValue(false);
    await disconnectConnector("x_social", "X (Twitter)");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing for a connector with no teardown endpoint", async () => {
    await disconnectConnector("linear", "Linear");
    expect(confirmAction).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("explains a non-admin rejection instead of echoing the raw error", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "not_admin", message: "permission denied" } }),
    });
    await disconnectConnector("x_social", "X (Twitter)");
    expect(showConnectorError).toHaveBeenCalledWith({
      title: "Couldn’t disconnect X (Twitter)",
      message: "Only a workspace owner or admin can disconnect X (Twitter). Ask one of them to do it.",
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("surfaces a network failure without reloading", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    await disconnectConnector("x_social", "X (Twitter)");
    expect(showConnectorError).toHaveBeenCalledWith({
      title: "Couldn’t disconnect X (Twitter)",
      message: "offline",
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("SendGrid disconnect refused for a member", () => {
  const SENTENCE = "Only a workspace owner or admin can disconnect SendGrid. Ask one of them to do it.";

  it.each(["forbidden", "not_admin"])("shows the backend's own sentence for %s", async (code) => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code, message: SENTENCE } }),
    });
    await disconnectConnector("email", "SendGrid");
    expect(apiFetch).toHaveBeenCalledWith("/api/connectors/email", { method: "DELETE" });
    expect(showConnectorError).toHaveBeenCalledWith({
      title: "Couldn’t disconnect SendGrid",
      message: SENTENCE,
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("X Ads disconnect", () => {
  it("confirms and posts to the dedicated route before reloading", async () => {
    await disconnectConnector("x_ads", "X Ads");
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Disconnect X Ads?",
      description: CONNECTOR_DISCONNECT.x_ads.description,
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/connectors/x_ads/disconnect", {
      method: "POST",
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the connection when confirmation is dismissed", async () => {
    confirmAction.mockResolvedValue(false);
    await disconnectConnector("x_ads", "X Ads");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("explains an admin rejection without reloading", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "not_admin" } }),
    });
    await disconnectConnector("x_ads", "X Ads");
    expect(showConnectorError).toHaveBeenCalledWith({
      title: "Couldn’t disconnect X Ads",
      message: "Only a workspace owner or admin can disconnect X Ads. Ask one of them to do it.",
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("LinkedIn Ads disconnect", () => {
  it("warns that live campaigns keep spending and can no longer be paused from Zavi before anything is sent", async () => {
    let askedBeforeRequest = false;
    confirmAction.mockImplementation(async () => {
      askedBeforeRequest = apiFetch.mock.calls.length === 0;
      return true;
    });
    await disconnectConnector("linkedin_ads", "LinkedIn Ads");
    const [options] = confirmAction.mock.calls[0] as [{ title: string; description: string }];
    expect(options.title).toBe("Disconnect LinkedIn Ads?");
    expect(options.description).toMatch(/ad accounts you pay for yourself/);
    expect(options.description).toMatch(/keep running and spending/);
    expect(options.description).toMatch(/Zavi can no longer pause them/);
    expect(options.description).toMatch(/Campaign Manager/);
    expect(askedBeforeRequest).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith("/api/connectors/linkedin_ads/disconnect", { method: "POST" });
  });

  it("must catch (Flow 35): the dialog never tells a founder Zavi loses its campaigns paid from the Zavi balance", async () => {
    await disconnectConnector("linkedin_ads", "LinkedIn Ads");
    const [options] = confirmAction.mock.calls[0] as [{ description: string }];
    expect(options.description).toMatch(/Campaigns paid from your Zavi balance are not affected, and Zavi can still pause them/);
    expect(options.description).not.toMatch(/Campaigns already running on LinkedIn keep running/);
  });

  it("must catch (Flow 2): a successful disconnect drops the tab's saved dashboard before the reload, so old numbers never paint", async () => {
    const order: string[] = [];
    clearChannelReadCache.mockImplementation(() => order.push("clear"));
    reload.mockImplementation(() => order.push("reload"));
    await disconnectConnector("linkedin_ads", "LinkedIn Ads");
    expect(order).toEqual(["clear", "reload"]);
  });

  it("must not catch: a failed disconnect keeps the saved dashboard, because the account is still connected", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { code: "rpc_failed", message: "x" } }) });
    await disconnectConnector("linkedin_ads", "LinkedIn Ads");
    expect(clearChannelReadCache).not.toHaveBeenCalled();
  });

  it.each([
    ["a raw database error", { error: { code: "rpc_failed", message: "duplicate key value violates unique constraint \"connector_metadata_pkey\"" } }],
    ["the migration wording", { error: { code: "rpc_missing", message: "Disconnect is temporarily unavailable: a pending database migration has not been applied." } }],
    ["an empty body", {}],
  ])("must catch (Flow 2): %s becomes plain words that say LinkedIn is still connected", async (_name, body) => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => body });
    await disconnectConnector("linkedin_ads", "LinkedIn Ads");
    const [arg] = showConnectorError.mock.calls[0] as [{ title: string; message: string }];
    expect(arg.title).toBe("Couldn’t disconnect LinkedIn Ads");
    expect(arg.message).toBe("LinkedIn Ads is still connected: Zavi couldn’t disconnect it just now. Try again in a minute.");
    expect(arg.message).not.toMatch(/HTTP|database|migration|constraint/);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("disconnect refusals worded by the server stay as they are on other channels", () => {
  it("must not catch: a founder-worded refusal from another channel's route is shown unchanged", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: "x_ads_busy", message: "X Ads is finishing a change. Try again in a minute." } }) });
    await disconnectConnector("x_ads", "X Ads");
    expect(showConnectorError).toHaveBeenCalledWith({ title: "Couldn’t disconnect X Ads", message: "X Ads is finishing a change. Try again in a minute." });
  });

  it("a Composio half that went through before the native half failed is not called still connected", async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await disconnectConnector("tiktok_ads", "TikTok Ads", { sourceSlugs: ["composio.tiktok_ads", "tiktok_ads"] });
    const [arg] = showConnectorError.mock.calls[0] as [{ message: string }];
    expect(arg.message).toBe("Zavi couldn’t finish disconnecting TikTok Ads, so part of it may still be connected. Try again in a minute.");
  });
});
