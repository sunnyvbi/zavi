import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  composio: vi.fn(async (_toolkit: string) => {}),
  pipedream: vi.fn(async (_app: string) => {}),
  oauth: vi.fn(async (_slug: string) => {}),
}));
vi.mock("./composioConnect", () => ({ startComposioConnect: m.composio }));
vi.mock("./pipedreamConnect", () => ({ startPipedreamConnect: m.pipedream }));
vi.mock("./ConnectButton", () => ({ startConnectFlow: m.oauth }));

import { CONNECTOR_CONNECT, CONNECTOR_DESCRIPTORS, connectInfoFor, connectorHasConnectPath } from "@zavi/shared";
import { findConnectorRow, isRequestSatisfied, launchConnect } from "./connectStrategies";

beforeEach(() => {
  m.composio.mockClear();
  m.pipedream.mockClear();
  m.oauth.mockClear();
  (globalThis as { window?: unknown }).window = { location: { href: "" } };
});

describe("launchConnect follows railFor", () => {
  it("instagram_social, composio.youtube and reddit_social open Composio, never Pipedream", async () => {
    await launchConnect("instagram_social", CONNECTOR_CONNECT.instagram_social);
    await launchConnect("composio.youtube", CONNECTOR_CONNECT["composio.youtube"]);
    await launchConnect("reddit_social", CONNECTOR_CONNECT.reddit_social);
    expect(m.composio.mock.calls.map((c) => c[0])).toEqual(["instagram", "youtube", "reddit"]);
    expect(m.pipedream).not.toHaveBeenCalled();
  });

  it("a composio.<app> card opens Composio for that toolkit", async () => {
    await launchConnect("composio.notion", connectInfoFor("composio.notion")!);
    expect(m.composio).toHaveBeenCalledWith("notion");
  });

  it("a Stripe card goes to the native key form, never Composio or Pipedream", async () => {
    await launchConnect("stripe", CONNECTOR_CONNECT.stripe);
    expect(m.composio).not.toHaveBeenCalled();
    expect(m.pipedream).not.toHaveBeenCalled();
    expect((globalThis as { window: { location: { href: string } } }).window.location.href).toBe(
      "/workspace?tab=settings#connector-stripe",
    );
  });

  it("a legacy pipedream.<app> card never reaches Pipedream (it is unreachable)", async () => {
    await launchConnect("pipedream.instagram_business", connectInfoFor("pipedream.instagram_business")!);
    await launchConnect("pipedream.youtube_analytics_api", connectInfoFor("pipedream.youtube_analytics_api")!);
    expect(m.composio.mock.calls.map((c) => c[0])).toEqual(["instagram", "youtube"]);
    await launchConnect("pipedream.hubspot", connectInfoFor("pipedream.hubspot")!);
    expect(m.pipedream).not.toHaveBeenCalled();
    expect((globalThis as { window: { location: { href: string } } }).window.location.href).toBe(
      "/workspace?tab=settings#integration",
    );
  });
});

describe("findConnectorRow", () => {
  it("never counts the Zavi umbrella GitHub row as the tenant's GitHub", () => {
    expect(findConnectorRow([{ slug: "github", account_login: "Praxis-build" }], "github")).toBeNull();
    expect(findConnectorRow([{ slug: "github", account_login: "acme" }], "github")).not.toBeNull();
  });

  it("instagram_social / composio.youtube are connected by their Composio rows, not Pipedream rows", () => {
    expect(findConnectorRow([{ slug: "composio.instagram" }], "instagram_social")).not.toBeNull();
    expect(findConnectorRow([{ slug: "composio.youtube" }], "composio.youtube")).not.toBeNull();
    expect(findConnectorRow([{ slug: "youtube_social" }], "composio.youtube")).toBeNull();
    expect(findConnectorRow([{ slug: "composio.reddit" }], "reddit_social")).not.toBeNull();
    expect(findConnectorRow([{ slug: "pipedream.instagram_business" }], "instagram_social")).toBeNull();
  });
});

describe("isRequestSatisfied", () => {
  const req = { slug: "stripe", mode: "reconnect" as const, created_at: "2026-09-22T10:00:00Z" };
  it("reconnect needs a connected_at after the request", () => {
    expect(isRequestSatisfied([{ slug: "stripe", connected_at: "2026-09-22T09:00:00Z" }], req)).toBe(false);
    expect(isRequestSatisfied([{ slug: "stripe", connected_at: "2026-09-22T11:00:00Z" }], req)).toBe(true);
    expect(isRequestSatisfied([{ slug: "stripe", connected_at: null }], req)).toBe(false);
  });
});

describe("connectorHasConnectPath", () => {
  it("is true for SendGrid now that it has a Settings tile with a key form", () => {
    expect(connectorHasConnectPath("email")).toBe(true);
  });

  it("stays true for connectors the founder can actually link", () => {
    expect(connectorHasConnectPath("posthog")).toBe(true);
    expect(connectorHasConnectPath("apple_ads")).toBe(true);
    expect(connectorHasConnectPath("reddit_ads")).toBe(true);
    expect(connectorHasConnectPath("composio.instagram")).toBe(true);
  });

  it("hides the Connect ask for no declared connector (every one has a connect path)", () => {
    const hidden = CONNECTOR_DESCRIPTORS.map((d) => d.slug).filter((s) => !connectorHasConnectPath(s));
    expect(hidden).toEqual([]);
  });
});
