
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { startConnectFlow } = vi.hoisted(() => ({ startConnectFlow: vi.fn() }));

vi.mock("@/app/connectors/ConnectButton", () => ({
  startConnectFlow,
  ConnectButton: ({ slug }: { slug: string }) =>
    React.createElement("button", { "data-connect": slug }, "Connect"),
}));
vi.mock("@/app/connectors/connectStrategies", () => ({
  launchConnect: vi.fn(),
  findConnectorRow: vi.fn(),
  isRequestSatisfied: vi.fn(),
}));
vi.mock("@/app/connectors/MetaAdsConnectButton", () => ({
  MetaAdsConnectButton: () => React.createElement("span"),
}));
vi.mock("@/app/connectors/GoogleAdsConnectButton", () => ({
  GoogleAdsConnectButton: () => React.createElement("span"),
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
  SlackWorkspacesPanel: () => React.createElement("span"),
}));

import {
  ConnectorRowView,
  GithubInstallAnotherOrg,
} from "./SettingsTab";

const COPY_NEEDLE = "install Zavi on that organization too";
const BUTTON_NEEDLE = "Install on another organization";

const GITHUB_BASE = {
  slug: "github" as const,
  connected: true,
  account_login: "rravi149",
};

function renderRow(
  row: Parameters<typeof ConnectorRowView>[0]["row"],
  { readOnly = false, flashConnected = true }: { readOnly?: boolean; flashConnected?: boolean } = {},
) {
  return renderToStaticMarkup(
    React.createElement(ConnectorRowView, {
      row,
      flashConnected,
      readOnly,
    }),
  );
}

describe("GitHub tile — Install on another organization (June-8 item C)", () => {
  it("renders the helper copy + button when connected WITH repos (expanded)", () => {
    const html = renderRow({
      ...GITHUB_BASE,
      repo_count: 2,
      repo_full_names: ["rravi149/praxis", "rravi149/upcar"],
    });
    expect(html).toContain(COPY_NEEDLE);
    expect(html).toContain(BUTTON_NEEDLE);
  });

  it("renders the helper copy + button when connected with ZERO repos (contributor-only symptom)", () => {
    const html = renderRow({
      ...GITHUB_BASE,
      repo_count: 0,
      repo_full_names: [],
    });
    expect(html).toContain(COPY_NEEDLE);
    expect(html).toContain(BUTTON_NEEDLE);
  });

  it("collapses the card body by default — install block hidden until expanded", () => {
    const html = renderRow(
      { ...GITHUB_BASE, repo_count: 2, repo_full_names: ["rravi149/praxis", "rravi149/upcar"] },
      { flashConnected: false },
    );
    expect(html).not.toContain(BUTTON_NEEDLE);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Manage");
  });

  it("hides the install affordance for read-only members", () => {
    const html = renderRow(
      { ...GITHUB_BASE, repo_count: 0, repo_full_names: [] },
      { readOnly: true },
    );
    expect(html).not.toContain(BUTTON_NEEDLE);
  });

  it("does NOT render the install block for a disconnected GitHub tile", () => {
    const html = renderRow({
      slug: "github",
      connected: false,
    });
    expect(html).not.toContain(BUTTON_NEEDLE);
  });

  it("renders the brand icon+title lockup for a mapped connector (icon-only redesign)", () => {
    const html = renderRow({
      slug: "stripe",
      connected: true,
      team_name: "acct@upcar.ai",
    });
    expect(html).toContain("/logos/stripe-icon.svg");
    expect(html).toContain(">Stripe</span>");
  });

  it("renders the TikTok app icon on the TikTok tile, not the monogram", () => {
    const html = renderRow({ slug: "tiktok", connected: true });
    expect(html).toContain("/logos/tiktok-channel.svg");
    expect(html).toContain(">TikTok</span>");
  });

  it("renders the database glyph for Operator DB (matches the home Finish-Setup icon)", () => {
    const html = renderRow({
      slug: "operator_db",
      connected: true,
      db_type: "postgres",
    });
    expect(html).toContain("/logos/database-icon.svg");
    expect(html).toContain("Your database");
  });

  it("holds the connected-tile actions behind ONE Manage menu (one-action grammar)", () => {
    const html = renderRow({
      slug: "jira",
      connected: true,
      team_name: "upcar-team",
    });
    expect(html).toContain("Manage");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Connected");
    expect(html).toContain(">Jira</span>");
  });

  it("button click fires startConnectFlow('github') — the same helper ConnectButton uses", () => {
    startConnectFlow.mockClear();
    const el = GithubInstallAnotherOrg({});
    type Node = { props?: { onClick?: () => void; children?: unknown } } | unknown;
    let clicked = false;
    const visit = (node: Node) => {
      if (!node || typeof node !== "object") return;
      const props = (node as { props?: { onClick?: () => void; children?: unknown } }).props;
      if (props?.onClick) {
        props.onClick();
        clicked = true;
      }
      const children = props?.children;
      if (Array.isArray(children)) children.forEach(visit);
      else if (children) visit(children as Node);
    };
    visit(el as Node);
    expect(clicked).toBe(true);
    expect(startConnectFlow).toHaveBeenCalledWith("github");
  });
});

describe("GitHub card for a Zavi-built app (the Praxis-build row)", () => {
  const managedRow = {
    ...GITHUB_BASE,
    account_login: "Praxis-build",
    account_type: "Organization",
    repo_count: 1,
    repo_full_names: ["Praxis-build/growth-agent-27927914"],
  };

  it("says Managed by Zavi, not Connected — the founder has not connected a GitHub of their own", () => {
    const html = renderRow(managedRow);
    expect(html).toContain("Managed by Zavi");
    expect(html).not.toContain(">Connected<");
  });

  it("drops Disconnect and repo limiting, which the server refuses for this row", () => {
    const html = renderRow(managedRow);
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain("Choose which repos Zavi can use");
  });

  it("explains where the code is and leads to connecting their own GitHub", () => {
    const html = renderRow(managedRow);
    expect(html).toContain("Praxis-build/growth-agent-27927914");
    expect(html).toContain("Export to GitHub");
    expect(html).toContain("Connect a GitHub account you own");
    expect(html).toContain(BUTTON_NEEDLE);
  });

  it("leaves a founder's own GitHub exactly as it was", () => {
    const html = renderRow({ ...GITHUB_BASE, repo_count: 1, repo_full_names: ["acme/app"] });
    expect(html).toContain("Connected");
    expect(html).toContain("Disconnect");
    expect(html).toContain(COPY_NEEDLE);
    expect(html).not.toContain("Managed by Zavi");
  });
});

describe("GitHub card shows which repos Zavi can use", () => {
  const rows = {
    ...GITHUB_BASE,
    repo_count: 3,
    repo_full_names: ["rravi149/upcar", "rravi149/apna-tutor", "rravi149/zavi"],
    repo_ids: [1, 2, 3],
  };

  it("with a selection: counts it, lists usable repos first, and marks the rest Not allowed", () => {
    const html = renderRow({ ...rows, selected_repo_ids: [3] });
    expect(html).toContain("Zavi can use 1 of 3 repositories");
    expect(html.indexOf("zavi</span>")).toBeLessThan(html.indexOf("upcar</span>"));
    expect(html.match(/Not allowed/g)).toHaveLength(2);
    expect(html).toContain("Allow Zavi to use rravi149/upcar");
    expect(html.match(/Base branch for /g)).toHaveLength(1);
  });

  it("with no selection (all repos): nothing is marked Not allowed", () => {
    const html = renderRow({ ...rows, selected_repo_ids: null });
    expect(html).toContain("Zavi can use all 3 repositories");
    expect(html).not.toContain("Not allowed");
    expect(html.match(/Base branch for /g)).toHaveLength(3);
  });

  it("read-only members see Not allowed but no Allow button", () => {
    const html = renderRow({ ...rows, selected_repo_ids: [3] }, { readOnly: true });
    expect(html).toContain("Not allowed");
    expect(html).not.toContain("Allow Zavi to use");
  });
});
