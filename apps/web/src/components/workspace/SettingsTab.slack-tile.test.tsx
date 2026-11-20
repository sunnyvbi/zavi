
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { startConnectFlow } = vi.hoisted(() => ({ startConnectFlow: vi.fn() }));

vi.mock("@/app/connectors/ConnectButton", () => ({
  startConnectFlow,
  ConnectButton: ({ slug }: { slug: string }) =>
    React.createElement("button", { "data-connect": slug }, "Connect"),
}));
vi.mock("@/app/connectors/MetaAdsConnectButton", () => ({
  MetaAdsConnectButton: () => React.createElement("span"),
  startMetaAdsConnect: vi.fn(),
}));
vi.mock("@/app/connectors/GoogleAdsConnectButton", () => ({
  GoogleAdsConnectButton: () => React.createElement("span"),
  startGoogleAdsConnect: vi.fn(),
}));
vi.mock("@/app/connectors/GoogleAnalyticsConnectButton", () => ({
  GoogleAnalyticsConnectButton: () => React.createElement("span"),
  startGoogleAnalyticsConnect: vi.fn(),
}));
vi.mock("@/app/connectors/OperatorDbConnectButton", () => ({
  OperatorDbConnectButton: () => React.createElement("span"),
  OperatorDbForm: () => React.createElement("span"),
}));
vi.mock("@/app/connectors/StripeConnectButton", () => ({
  StripeConnectButton: () => React.createElement("span"),
  StripeForm: () => React.createElement("span"),
  startStripePipedreamConnect: vi.fn(),
}));
vi.mock("@/app/connectors/SocialConnectButton", () => ({
  SocialConnectButton: () => React.createElement("span"),
  SocialConnectForm: () => React.createElement("span"),
  SocialConnectionsList: () => React.createElement("span"),
}));
vi.mock("@/app/connectors/ComposioApps", () => ({
  ComposioApps: () => React.createElement("span"),
  ComposioAppTile: () => React.createElement("span"),
  matchesToolkitQuery: () => true,
  useComposioApps: () => ({
    toolkits: [],
    loaded: true,
    requested: new Set(),
    request: () => Promise.resolve(),
    available: [],
    connected: new Set(),
    busy: null,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  }),
}));
vi.mock("@/app/connectors/PipedreamApps", () => ({
  PipedreamApps: () => React.createElement("span"),
}));
vi.mock("./SlackWorkspacesPanel", () => ({
  SlackWorkspacesPanel: () =>
    React.createElement("span", { "data-slack-panel": "true" }),
}));

import { ConnectorRowView } from "./SettingsTab";

const render = (row: { slug: string; connected: boolean }) =>
  renderToStaticMarkup(
    React.createElement(ConnectorRowView, {
      row: row as never,
      flashConnected: false,
    }),
  );

describe("Slack tile", () => {
  it("renders unconnected Slack as a compact tile, not the rich panel", () => {
    const html = render({ slug: "slack", connected: false });

    expect(html).not.toContain("data-slack-panel");
    expect(html).toContain('id="connector-slack"');
    expect(html).toContain("Slack");
  });

  it("gives unconnected Slack ONE primary Connect action wired to the shared flow", () => {
    const html = render({ slug: "slack", connected: false });

    expect(html).not.toContain('data-connect="slack"');
    expect(html).toContain("<button");
    expect(html).toContain("Connect Slack");
    expect(html).toContain("Not connected");
  });

  it("renders unconnected Slack with the same tile chrome as GitHub", () => {
    const slack = render({ slug: "slack", connected: false });
    const github = render({ slug: "github", connected: false });

    expect(slack).not.toContain("col-span-full");
    for (const cls of ["rounded-[16px]", "border", "px-4", "py-3.5"]) {
      expect(slack).toContain(cls);
      expect(github).toContain(cls);
    }
  });

  it("still renders the rich panel once Slack is connected", () => {
    const html = render({ slug: "slack", connected: true });

    expect(html).toContain("data-slack-panel");
  });
});
