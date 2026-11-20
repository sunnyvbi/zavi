// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  composioErrorNotice,
  ConnectedAppTiles,
  isNativeFoldedSlug,
  matchesAppQuery,
  parseAggregatorSlug,
  prettyAppName,
  type ConnectedApp,
} from "./ConnectedApps";

describe("parseAggregatorSlug", () => {
  it("splits both rails", () => {
    expect(parseAggregatorSlug("composio.notion")).toEqual({
      rail: "composio",
      app: "notion",
    });
    expect(parseAggregatorSlug("pipedream.google_sheets")).toEqual({
      rail: "pipedream",
      app: "google_sheets",
    });
  });

  it("ignores native slugs — they have their own rows/tiles", () => {
    expect(parseAggregatorSlug("github")).toBeNull();
    expect(parseAggregatorSlug("slack")).toBeNull();
    expect(parseAggregatorSlug("operator_db")).toBeNull();
  });

  it("ignores a bare prefix with no app", () => {
    expect(parseAggregatorSlug("composio.")).toBeNull();
    expect(parseAggregatorSlug("pipedream.")).toBeNull();
  });
});

describe("prettyAppName", () => {
  it("title-cases an unknown slug rather than showing the raw slug", () => {
    expect(prettyAppName("google_sheets")).toBe("Google Sheets");
    expect(prettyAppName("some_new_app")).toBe("Some New App");
  });

  it("uses the override for names title-case gets wrong", () => {
    expect(prettyAppName("posthog")).toBe("PostHog");
    expect(prettyAppName("github")).toBe("GitHub");
  });

  it("never throws on empty input", () => {
    expect(prettyAppName("")).toBe("");
  });
});

describe("isNativeFoldedSlug", () => {
  it("excludes an aggregator slug a native tile already owns", () => {
    expect(isNativeFoldedSlug("pipedream.stripe")).toBe(true);
  });

  it("folds Composio Reddit and Instagram into their one native tile", () => {
    expect(isNativeFoldedSlug("composio.reddit")).toBe(true);
    expect(isNativeFoldedSlug("composio.instagram")).toBe(true);
    expect(isNativeFoldedSlug("composio.reddit_ads")).toBe(false);
  });

  it("keeps every ordinary aggregator connection", () => {
    expect(isNativeFoldedSlug("pipedream.posthog")).toBe(false);
    expect(isNativeFoldedSlug("composio.notion")).toBe(false);
    expect(isNativeFoldedSlug("composio.stripe")).toBe(false);
  });
});

describe("matchesAppQuery", () => {
  const app: ConnectedApp = {
    rail: "pipedream",
    app: "google_sheets",
    slug: "pipedream.google_sheets",
    name: "Google Sheets",
    logo: null,
  };

  it("matches on the display name and on the raw slug", () => {
    expect(matchesAppQuery(app, "sheets")).toBe(true);
    expect(matchesAppQuery(app, "google_sh")).toBe(true);
    expect(matchesAppQuery(app, "GOOGLE")).toBe(true);
  });

  it("keeps every app when the search box is empty", () => {
    expect(matchesAppQuery(app, "")).toBe(true);
    expect(matchesAppQuery(app, "   ")).toBe(true);
  });

  it("filters out a non-match", () => {
    expect(matchesAppQuery(app, "notion")).toBe(false);
  });
});

describe("ConnectedAppTiles", () => {
  afterEach(() => cleanup());

  const apps: ConnectedApp[] = [
    {
      rail: "composio",
      app: "notion",
      slug: "composio.notion",
      name: "Notion",
      logo: null,
    },
    {
      rail: "pipedream",
      app: "posthog",
      slug: "pipedream.posthog",
      name: "PostHog",
      logo: null,
    },
  ];

  it("renders a connected tile per app even with no catalog logo", () => {
    render(<ConnectedAppTiles apps={apps} readOnly={false} onRemoved={() => {}} />);
    expect(screen.getAllByText("Notion").length).toBeGreaterThan(0);
    expect(screen.getAllByText("PostHog").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Manage" })).toHaveLength(2);
  });

  it("offers no connect/disconnect control to a read-only member", () => {
    render(<ConnectedAppTiles apps={apps} readOnly onRemoved={() => {}} />);
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(screen.getAllByText("connected")).toHaveLength(2);
  });

  it("never asks a connected app to be connected again", () => {
    const connected: ConnectedApp[] = [
      { rail: "composio", app: "pinterest", slug: "composio.pinterest", name: "Pinterest", logo: null },
      { rail: "composio", app: "acme_crm", slug: "composio.acme_crm", name: "Acme CRM", logo: null },
      { rail: "pipedream", app: "zoho_books", slug: "pipedream.zoho_books", name: "Zoho Books", logo: null },
    ];
    const { container } = render(<ConnectedAppTiles apps={connected} readOnly={false} onRemoved={() => {}} />);
    expect(container.textContent).not.toMatch(/Connect [^.]* so agents can use it\./);
    expect(screen.queryByText("Connect Pinterest so agents can use it.")).toBeNull();
    expect(screen.getByText("Publish approved pins to Pinterest.")).toBeTruthy();
    expect(screen.getByText("Connected. Agents can use Acme CRM.")).toBeTruthy();
    expect(screen.getByText("Connected. Agents can use Zoho Books.")).toBeTruthy();
  });
});

describe("composioErrorNotice", () => {
  it("a Google connect missing its box says which box to tick", () => {
    expect(composioErrorNotice("google_analytics", "Google Analytics", "google_scope_missing")).toBe(
      "Google didn’t give Zavi access to Google Analytics. Click Connect and tick the Google Analytics box on Google’s screen.",
    );
    expect(composioErrorNotice("google_search_console", "Google Search Console", "google_scope_missing")).toContain("tick the Search Console box");
  });

  it("any other failure keeps the plain line", () => {
    expect(composioErrorNotice("notion", "Notion", "mcp_sync_failed")).toBe("Couldn’t connect Notion. Try again.");
    expect(composioErrorNotice("google_analytics", "Google Analytics", null)).toBe("Couldn’t connect Google Analytics. Try again.");
  });
});
