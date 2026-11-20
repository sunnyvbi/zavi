
import { describe, it, expect } from "vitest";
import { partitionConnectorRows, DEFAULT_FOR_YOU_SLUGS, FOR_YOU_CAP } from "./SettingsTab";

type Row = Parameters<typeof partitionConnectorRows>[0][number];
const row = (slug: Row["slug"], connected = false, health?: Row["health"]): Row => ({
  slug,
  connected,
  health,
});

const slugs = (rows: Row[]) => rows.map((r) => r.slug);
const all = (b: ReturnType<typeof partitionConnectorRows>) => [
  ...b.needsReconnect,
  ...b.connected,
  ...b.forYou,
  ...b.rest,
];

describe("partitionConnectorRows", () => {
  it("puts an unconnected rich connector in `forYou`, not nowhere", () => {
    const b = partitionConnectorRows([row("slack")], "");

    expect(slugs(b.forYou)).toEqual(["slack"]);
    expect(b.connected).toHaveLength(0);
    expect(b.rest).toHaveLength(0);
  });

  it("puts an unconnected github in `forYou` too (the latent half)", () => {
    const b = partitionConnectorRows([row("github")], "");

    expect(slugs(b.forYou)).toEqual(["github"]);
    expect(b.rest).toHaveLength(0);
  });

  it("keeps every connected connector in `connected`, rich cards first", () => {
    const b = partitionConnectorRows(
      [row("stripe", true), row("slack", true), row("operator_db", true), row("github", true)],
      "",
    );

    expect(slugs(b.connected).slice(0, 2).sort()).toEqual(["github", "slack"]);
    expect(slugs(b.connected).slice(2).sort()).toEqual(["operator_db", "stripe"]);
    expect(b.forYou).toHaveLength(0);
    expect(b.rest).toHaveLength(0);
  });

  it("never suggests an already-connected connector in For You", () => {
    const b = partitionConnectorRows(
      [row("slack", true), row("github", true), row("stripe")],
      "",
      ["slack", "github", "stripe"],
    );

    expect(slugs(b.forYou)).toEqual(["stripe"]);
  });

  it("follows the caller's For You order and caps the list", () => {
    const rows = DEFAULT_FOR_YOU_SLUGS.map((s) => row(s));
    const order = [...DEFAULT_FOR_YOU_SLUGS].reverse();
    const b = partitionConnectorRows(rows, "", order);

    expect(b.forYou).toHaveLength(FOR_YOU_CAP);
    expect(slugs(b.forYou)).toEqual(order.slice(0, FOR_YOU_CAP));
    expect(slugs(b.rest).sort()).toEqual(order.slice(FOR_YOU_CAP).sort());
  });

  it("ignores For You slugs that have no row", () => {
    const b = partitionConnectorRows([row("jira")], "", ["notion", "jira"]);

    expect(slugs(b.forYou)).toEqual(["jira"]);
  });

  it("moves expired / scope-drift rows to `needsReconnect`, out of `connected`", () => {
    const b = partitionConnectorRows(
      [
        row("meta_ads", true, { status: "expired", reason: "expired" }),
        row("slack", true, { status: "scope_drift", reason: "drift" }),
        row("google_ads", true, { status: "expiring", daysToExpiry: 3 }),
        row("jira", true, { status: "ok" }),
      ],
      "",
    );

    expect(slugs(b.needsReconnect).sort()).toEqual(["meta_ads", "slack"]);
    expect(slugs(b.connected).sort()).toEqual(["google_ads", "jira"]);
  });

  it("keeps an unconnected rich connector findable by search", () => {
    const b = partitionConnectorRows(
      [row("slack"), row("stripe"), row("operator_db", true)],
      "slack",
    );

    expect(slugs(all(b))).toEqual(["slack"]);
  });

  it("matches search on the slug as well as the label", () => {
    const b = partitionConnectorRows([row("google_search_console"), row("jira")], "search_con");

    expect(slugs(all(b))).toEqual(["google_search_console"]);
  });

  it("lands every row in exactly one bucket", () => {
    const rows = [
      row("slack", true, { status: "scope_drift" }),
      row("github", true),
      row("stripe"),
      row("operator_db"),
      row("higgsfield"),
    ];
    const b = partitionConnectorRows(rows, "");

    expect(slugs(all(b)).sort()).toEqual(slugs(rows).sort());
  });
});
