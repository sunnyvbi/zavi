// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));
vi.mock("@/components/workspace/settings/connectorErrorDialog", () => ({ showConnectorError: vi.fn() }));

import { CONNECT_RETURN_KEY, takeConnectReturn } from "./ConnectButton";
import { startGoogleAdsConnect } from "./GoogleAdsConnectButton";
import { startGoogleSheetsConnect } from "./GoogleWorkspaceConnect";

describe("popup OAuth starters remember the page", () => {
  beforeEach(() => {
    sessionStorage.clear();
    m.fetch.mockReset();
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=google_ads");
    vi.spyOn(window, "open").mockReturnValue({ location: { href: "" }, close: vi.fn() } as unknown as Window);
  });

  it("returns to the channel page after a popup connect", async () => {
    m.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ oauth_url: "https://oauth" }) });
    await startGoogleAdsConnect();
    expect(takeConnectReturn("?tab=settings&google_ads=connected")).toBe(
      "/workspace?tab=channels&channel=google_ads&google_ads=connected",
    );
  });

  it("a failed start remembers nothing", async () => {
    m.fetch.mockResolvedValue({ status: 502, ok: false, json: async () => ({}) });
    await startGoogleSheetsConnect();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });
});
