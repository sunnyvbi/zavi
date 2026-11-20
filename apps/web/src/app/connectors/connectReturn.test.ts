// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { CONNECT_RETURN_KEY, rememberConnectReturn, takeConnectReturn } from "./ConnectButton";

beforeEach(() => sessionStorage.clear());

describe("rememberConnectReturn / takeConnectReturn", () => {
  it("returns a cancelled onboarding connection to its saved search and form", () => {
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=autopilot&setupStep=connect-apps&connectSearch=google&connectApp=stripe" });
    expect(takeConnectReturn("?tab=settings&composio_error=google_analytics&code=cancelled")).toBe(
      "/workspace?tab=autopilot&setupStep=connect-apps&connectSearch=google&connectApp=stripe&composio_error=google_analytics&code=cancelled",
    );
  });
  it("remembers a thread location and returns it on the connected landing, once", () => {
    rememberConnectReturn({ pathname: "/workspace", search: "?agent=operator&thread=t-1" });
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBe("/workspace?agent=operator&thread=t-1");
    expect(takeConnectReturn("?tab=settings&x_social=connected")).toBe(
      "/workspace?agent=operator&thread=t-1&x_social=connected",
    );
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("remembers a /workspace/<threadId> conversation", () => {
    rememberConnectReturn({ pathname: "/workspace/0b6d4c1e-1111-4222-8333-944455556666", search: "" });
    expect(takeConnectReturn("?tab=settings&composio_reddit_ads=connected")).toBe(
      "/workspace/0b6d4c1e-1111-4222-8333-944455556666?composio_reddit_ads=connected",
    );
  });

  it("returns to a channel page, and to Connectors with its hash kept", () => {
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=channels&channel=reddit_ads" });
    expect(takeConnectReturn("?tab=settings&composio_reddit_ads=connected")).toBe(
      "/workspace?tab=channels&channel=reddit_ads&composio_reddit_ads=connected",
    );
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=brain", hash: "#integrations" });
    expect(takeConnectReturn("?tab=settings&meta_ads=connected")).toBe(
      "/workspace?tab=brain&meta_ads=connected#integrations",
    );
  });

  it("lands on Connectors when nothing was remembered", () => {
    expect(takeConnectReturn("?tab=settings&composio_reddit_ads=connected")).toBe(
      "/workspace?tab=brain&composio_reddit_ads=connected#integrations",
    );
  });

  it("sends a failed connect to Connectors with its error, and forgets the page", () => {
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=channels&channel=reddit_ads" });
    expect(takeConnectReturn("?tab=settings&composio_error=reddit_ads&code=invalid_state")).toBe(
      "/workspace?tab=brain&composio_error=reddit_ads&code=invalid_state#integrations",
    );
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("does not remember Settings or non-workspace pages", () => {
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=settings" });
    rememberConnectReturn({ pathname: "/approvals", search: "" });
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("takes nothing on a page that is not the OAuth landing", () => {
    sessionStorage.setItem(CONNECT_RETURN_KEY, "/workspace?thread=t-1");
    expect(takeConnectReturn("?tab=approvals")).toBeNull();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBe("/workspace?thread=t-1");
    expect(takeConnectReturn("?tab=channels&channel=reddit_ads&composio_reddit_ads=connected")).toBeNull();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("refuses a remembered path outside /workspace", () => {
    for (const bad of ["https://evil.example/", "//evil.example/workspace", "/workspacefoo", "/approvals"]) {
      sessionStorage.setItem(CONNECT_RETURN_KEY, bad);
      expect(takeConnectReturn("?tab=settings&x_social=connected")).toBe(
        "/workspace?tab=brain&x_social=connected#integrations",
      );
    }
  });
});

describe("returnFromConnect", () => {
  it("moves the workspace straight back to the channel page in place, with no server navigation, and tells the workspace", async () => {
    const { returnFromConnect } = await import("./ConnectButton");
    const { WORKSPACE_LOCATION_EVENT } = await import("@/components/workspace/navigation/workspaceRoutes");
    rememberConnectReturn({ pathname: "/workspace", search: "?tab=channels&channel=linkedin_ads" });
    window.history.replaceState(null, "", "/workspace?tab=settings&linkedin_ads=connected");
    let told = 0;
    const onMove = () => told++;
    window.addEventListener(WORKSPACE_LOCATION_EVENT, onMove);
    expect(returnFromConnect()).toBe(true);
    window.removeEventListener(WORKSPACE_LOCATION_EVENT, onMove);
    expect(window.location.pathname + window.location.search).toBe("/workspace?tab=channels&channel=linkedin_ads&linkedin_ads=connected");
    expect(told).toBe(1);
    expect(returnFromConnect()).toBe(false);
  });

  it("sends a connect with nothing remembered to Connectors, never leaving the founder on Settings", async () => {
    const { returnFromConnect } = await import("./ConnectButton");
    window.history.replaceState(null, "", "/workspace?tab=settings&composio_pinterest=connected");
    expect(returnFromConnect()).toBe(true);
    expect(window.location.search).toBe("?tab=brain&composio_pinterest=connected");
    expect(window.location.hash).toBe("#integrations");
  });
});
