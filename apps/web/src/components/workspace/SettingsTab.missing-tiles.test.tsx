// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { cleanup, render, fireEvent } from "@testing-library/react";

const {
  startConnectFlow,
  startGoogleCalendarConnect,
  startGoogleSheetsConnect,
} = vi.hoisted(() => ({
  startConnectFlow: vi.fn(),
  startGoogleCalendarConnect: vi.fn(),
  startGoogleSheetsConnect: vi.fn(),
}));

vi.mock("@/app/connectors/ConnectButton", () => ({
  startConnectFlow,
  ConnectButton: ({ slug }: { slug: string }) =>
    React.createElement("button", { "data-connect": slug }, "Connect"),
}));
vi.mock("@/app/connectors/GoogleWorkspaceConnect", () => ({
  startGoogleCalendarConnect,
  startGoogleSheetsConnect,
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
vi.mock("@/app/connectors/GoogleSearchConsoleConnectButton", () => ({
  GoogleSearchConsoleConnectButton: () => React.createElement("span"),
  startGoogleSearchConsoleConnect: vi.fn(),
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
  SlackWorkspacesPanel: () => React.createElement("span", { "data-slack-panel": "true" }),
}));

vi.mock("@/app/connectors/PosthogConnectForm", () => ({
  PosthogForm: () => React.createElement("div", { "data-form": "posthog" }),
}));
vi.mock("@/app/connectors/HiggsfieldConnectForm", () => ({
  HiggsfieldForm: () => React.createElement("div", { "data-form": "higgsfield" }),
}));
vi.mock("@/app/connectors/SentryConnectForm", () => ({
  SentryForm: () => React.createElement("div", { "data-form": "sentry" }),
}));
vi.mock("@/app/connectors/FigmaConnectForm", () => ({
  FigmaForm: () => React.createElement("div", { "data-form": "figma" }),
}));
vi.mock("@/app/connectors/SupabaseConnectForm", () => ({
  SupabaseForm: () => React.createElement("div", { "data-form": "supabase" }),
}));

import { ConnectorRowView, partitionConnectorRows } from "./SettingsTab";
import { CONNECTOR_CONNECT, CONNECTOR_DESCRIPTORS, connectorSettingsPath } from "@zavi/shared";

const D1_SLUGS: [string, string][] = [
  ["sentry", "Sentry"],
  ["figma", "Figma"],
  ["supabase", "Supabase"],
  ["google_calendar", "Google Calendar"],
  ["google_sheets", "Google Sheets"],
];
const PASTE_KEY = ["sentry", "figma", "supabase"];

function mount(slug: string, connected = false) {
  return render(
    React.createElement(ConnectorRowView, {
      row: { slug, connected } as never,
      flashConnected: false,
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("D1 — the five connectors with no Settings tile", () => {
  it.each(D1_SLUGS)("renders an unconnected %s tile", (slug, label) => {
    const { container } = mount(slug);

    expect(container.querySelector(`#connector-${slug}`)).not.toBeNull();
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("Not connected");
  });

  it.each(D1_SLUGS)("renders a CONNECTED %s tile too", (slug, label) => {
    const { container } = mount(slug, true);

    expect(container.querySelector(`#connector-${slug}`)).not.toBeNull();
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("Connected");
  });

  it.each(D1_SLUGS)("lets search reach %s (the LABELS lookup that threw)", (slug, label) => {
    const { connected, forYou, rest } = partitionConnectorRows(
      [{ slug, connected: false }] as never,
      label.slice(0, 3).toLowerCase(),
    );

    expect([...connected, ...forYou, ...rest].map((r) => r.slug)).toEqual([slug]);
  });

  it.each(PASTE_KEY)("clicking %s Connect opens its paste-key form, not an OAuth start", (slug) => {
    const { container } = mount(slug);
    fireEvent.click(container.querySelector(`#connector-${slug} button`)!);

    expect(container.querySelector(`[data-form="${slug}"]`)).not.toBeNull();
    expect(startConnectFlow).not.toHaveBeenCalled();
  });

  it("clicking Google Calendar starts its popup OAuth, not startConnectFlow", () => {
    const { container } = mount("google_calendar");
    fireEvent.click(container.querySelector("#connector-google_calendar button")!);

    expect(startGoogleCalendarConnect).toHaveBeenCalledTimes(1);
    expect(startConnectFlow).not.toHaveBeenCalled();
  });

  it("clicking Google Sheets starts its popup OAuth, not startConnectFlow", () => {
    const { container } = mount("google_sheets");
    fireEvent.click(container.querySelector("#connector-google_sheets button")!);

    expect(startGoogleSheetsConnect).toHaveBeenCalledTimes(1);
    expect(startConnectFlow).not.toHaveBeenCalled();
  });
});

describe("D3 — PostHog's paste-key form is reachable before connecting", () => {
  it("clicking an UNCONNECTED PostHog tile opens the form", () => {
    const { container } = mount("posthog");
    fireEvent.click(container.querySelector("#connector-posthog button")!);

    expect(container.querySelector('[data-form="posthog"]')).not.toBeNull();
    expect(startConnectFlow).not.toHaveBeenCalled();
  });

  it("clicking again closes it (a toggle, like every other inline form)", () => {
    const { container } = mount("posthog");
    const tile = container.querySelector("#connector-posthog button")!;
    fireEvent.click(tile);
    expect(container.querySelector('[data-form="posthog"]')).not.toBeNull();
    fireEvent.click(tile);

    expect(container.querySelector('[data-form="posthog"]')).toBeNull();
  });

  it("still promises a pasted key in the tile copy", () => {
    const { container } = mount("posthog");

    expect(container.querySelector("#connector-posthog")!.getAttribute("title")).toMatch(
      /Paste a PostHog API key/,
    );
  });
});

describe("descriptor ↔ Settings parity for these connectors", () => {
  it("every D1 slug really is declared settingsTile: true", () => {
    for (const [slug] of D1_SLUGS) {
      const d = CONNECTOR_DESCRIPTORS.find((x) => x.slug === slug);
      expect(d, `${slug} missing from CONNECTOR_DESCRIPTORS`).toBeDefined();
      expect(d!.settingsTile).toBe(true);
    }
  });
});

describe("Connect SendGrid link", () => {
  it("lands on the SendGrid tile the Settings page renders", () => {
    const anchor = connectorSettingsPath(CONNECTOR_CONNECT.email).split("#")[1];
    const { container } = mount("email");

    const tile = container.querySelector(`#${anchor}`);
    expect(tile).not.toBeNull();
    expect(tile!.textContent).toContain("SendGrid");
  });
});

import { buildSettingsRows } from "./SettingsTab";

describe("buildSettingsRows: the descriptor's settingsTile slugs are ACTUALLY CONSTRUCTED", () => {
  it("every settingsTile:true native slug gets a row even with zero connections", () => {
    const built = new Set<string>(buildSettingsRows([]).map((r) => r.slug));
    const missing = CONNECTOR_DESCRIPTORS.filter(
      (d) => d.settingsTile && !d.slug.startsWith("composio.") && !built.has(d.slug),
    ).map((d) => d.slug);
    expect(missing, `settingsTile:true but buildSettingsRows emits no row: ${missing.join(", ")}`).toEqual([]);
  });

  it("a composio-only TikTok Ads connection lights the native row through the RAW list", () => {
    const raw = [
      {
        slug: "composio.tiktok_ads", team_id: null, team_name: "Upcar", account_login: null,
        repo_full_names: null, repo_ids: null, selected_repo_ids: null, default_repo_full_name: null,
        connected_at: "2026-10-01T00:00:00Z", token_expires_at: null,
      },
    ];
    const tiktok = buildSettingsRows(raw).find((r) => r.slug === "tiktok_ads");
    expect(tiktok?.connected).toBe(true);
    expect(tiktok?.team_name).toBe("Upcar");
  });
});
