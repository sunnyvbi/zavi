// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { CONNECT_RETURN_KEY, takeConnectReturn } from "./ConnectButton";
import { connectFailureNotice } from "@/components/workspace/settings/ConnectedApps";
import { workspaceTabHref } from "@/components/workspace/navigation/workspaceRoutes";
import type { TabDescriptor } from "@/lib/workspace/types";
import { setupNavigationHref } from "@/lib/onboardingRoutes";

const landing = "?tab=settings&connect_error=permission_denied&provider=linkedin_ads";

beforeEach(() => sessionStorage.clear());

describe("a cancelled provider sign-in on web", () => {
  it("moves off the hidden Settings landing to Connectors, where the message and the retry live", () => {
    sessionStorage.setItem(CONNECT_RETURN_KEY, "/workspace?tab=channels&channel=linkedin_ads");
    expect(takeConnectReturn(landing)).toBe("/workspace?tab=brain&connect_error=permission_denied&provider=linkedin_ads#integrations");
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("works with nothing remembered, as after a phone or a new tab", () => {
    expect(takeConnectReturn(landing)).toBe("/workspace?tab=brain&connect_error=permission_denied&provider=linkedin_ads#integrations");
  });

  it("says what happened and names the connector correctly", () => {
    const params = new URLSearchParams("connect_error=permission_denied&provider=linkedin_ads");
    expect(connectFailureNotice(params)).toBe("LinkedIn Ads didn’t finish connecting, so nothing was saved. If you cancelled, use Connect to try again.");
  });

  it("stays quiet with no failure, and once dismissed", () => {
    expect(connectFailureNotice(new URLSearchParams("tab=brain"))).toBeNull();
    expect(connectFailureNotice(new URLSearchParams("connect_error=x&provider=linear"), true)).toBeNull();
  });

  it("still reads when the provider slug is missing", () => {
    expect(connectFailureNotice(new URLSearchParams("connect_error=x"))).toContain("This connector didn’t finish connecting");
  });

  it("keeps the failure through a setup rebuild, then clears it when setup finishes", () => {
    const tab: TabDescriptor = { id: "growth", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false };
    const href = workspaceTabHref(tab, "/workspace?tab=brain&setupStep=connect-apps&connect_error=permission_denied&provider=linkedin_ads#integrations");
    const params = new URL(href, "https://zavi.test").searchParams;
    expect(params.get("connect_error")).toBe("permission_denied");
    expect(params.get("provider")).toBe("linkedin_ads");
    const cleared = setupNavigationHref("/workspace", params, { connect_error: null, provider: null }, "");
    expect(cleared).not.toContain("connect_error");
    expect(cleared).not.toContain("provider");
  });
});
