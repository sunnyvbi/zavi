
import { describe, it, expect } from "vitest";
import {
  buildRunCapabilitiesBlock,
  connectorsFromResolvedTools,
  contradictedConnector,
  redactContradictedClaims,
  withheldNoteStub,
} from "../run-capabilities";

describe("connectorsFromResolvedTools — the predicate is the RESOLVED TOOL SET", () => {
  it("derives connector families from mcp-prefixed and bare tool names", () => {
    const fams = connectorsFromResolvedTools([
      { name: "mcp__server__stripe__list_charges" },
      { name: "mcp__server__operator_db__query" },
      { name: "github__read_file" },
      { name: "mcp__server__memory__search" },
    ]);
    expect(fams).toContain("stripe");
    expect(fams).toContain("operator_db");
    expect(fams).toContain("github");
    expect(fams).not.toContain("mcp");
    expect(fams).not.toContain("server");
  });

  it("returns [] when no tools resolved (never asserts a capability we can't prove)", () => {
    expect(connectorsFromResolvedTools([])).toEqual([]);
  });
});

describe("buildRunCapabilitiesBlock — states what IS callable", () => {
  it("names the connected connectors positively and forbids denying them", () => {
    const block = buildRunCapabilitiesBlock(["github", "stripe"], ["linear"]);
    expect(block).toContain("CONNECTED");
    expect(block).toContain("stripe");
    expect(block).toContain("github");
    expect(block).toMatch(/memory note says otherwise/i);
    expect(block).toContain("NOT CONNECTED — no tools resolved for: linear.");
  });

  it("names connectors__request only when the run can call it", () => {
    expect(buildRunCapabilitiesBlock([], ["linear"], true)).toContain("call connectors__request");
    expect(buildRunCapabilitiesBlock([], ["linear"], false)).not.toContain("connectors__request");
    expect(buildRunCapabilitiesBlock([], ["linear"])).not.toContain("connectors__request");
  });

  it("claims CALLABILITY, not vendor health — we resolved tools, we did not probe", () => {
    const block = buildRunCapabilitiesBlock(["stripe"], []);
    expect(block).not.toMatch(/verified live|probed|healthy/i);
    expect(block).toMatch(/callable by you THIS RUN/i);
    expect(block).toMatch(/report the ACTUAL error/i);
  });

  it("still states the tenant boundary when NO connectors resolve", () => {
    const block = buildRunCapabilitiesBlock([], []);
    expect(block).not.toBe("");
    expect(block).toContain("TENANT SCOPE");
    expect(block).not.toContain("CONNECTED —");
    expect(block).not.toContain("NOT CONNECTED —");
  });
});

describe("buildRunCapabilitiesBlock — TENANT SCOPE (cross-tenant overclaim guard)", () => {
  it("always states the one-workspace bound, whatever the connector mix", () => {
    for (const [conn, disc] of [
      [[], []],
      [["slack"], []],
      [[], ["stripe"]],
      [["github", "slack"], ["stripe"]],
    ] as Array<[string[], string[]]>) {
      const block = buildRunCapabilitiesBlock(conn, disc);
      expect(block).toContain("TENANT SCOPE");
      expect(block).toMatch(/exactly ONE workspace/i);
      expect(block).toMatch(/NO cross-tenant visibility/i);
    }
  });

  it("forbids the exact phrases the incident reply used", () => {
    const block = buildRunCapabilitiesBlock(["slack"], []);
    expect(block).toMatch(/any connected system/i);
    expect(block).toMatch(/anywhere/i);
    expect(block).toMatch(/does not exist/i);
    expect(block).toMatch(/is not a client/i);
    expect(block).toMatch(/not in THIS workspace/i);
  });

  it("leaks no internal surface — identical text for every tenant, no slug or console link", () => {
    const a = buildRunCapabilitiesBlock(["slack"], []);
    const b = buildRunCapabilitiesBlock(["slack"], []);
    expect(a).toBe(b);
    expect(a).not.toMatch(/staff/i);
    expect(a).not.toMatch(/\/staff\/tenants/);
    expect(a).not.toMatch(/admin\.zaviagent\.com/);
  });
});

describe("contradictedConnector — withhold ONLY what the system proves false", () => {
  const CONNECTED = ["stripe", "github"];

  it("catches the exact note that produced the incident", () => {
    expect(
      contradictedConnector("Stripe not yet connected to Praxis workspace.", CONNECTED),
    ).toBe("stripe");
  });

  it("catches the GitHub notes blocking engineer on 3 other tenants", () => {
    expect(
      contradictedConnector("GitHub connector not wired; 4 engineer dispatches blocked.", CONNECTED),
    ).toBe("github");
  });

  it("catches the self-reinforcing note the brain wrote about its own false blocker", () => {
    expect(
      contradictedConnector("Stripe connection missing (7 consecutive reporting runs).", CONNECTED),
    ).toBe("stripe");
  });

  it("does NOT withhold a note about a connector the tenant genuinely LACKS", () => {
    expect(
      contradictedConnector("Linear is not connected, so tickets can't be filed.", CONNECTED),
    ).toBeNull();
  });

  it("does NOT withhold a note that merely MENTIONS a live connector", () => {
    expect(
      contradictedConnector("Stripe payouts run every Tuesday for verified hosts.", CONNECTED),
    ).toBeNull();
  });

  it("does NOT condemn a connector named in an unrelated clause", () => {
    expect(
      contradictedConnector("Stripe fees are 2.9%. Linear is not connected.", CONNECTED),
    ).toBeNull();
  });

  it("returns null when nothing is connected (no capability => no proof => no withhold)", () => {
    expect(contradictedConnector("Stripe is not connected.", [])).toBeNull();
  });

  it.each([
    "Stripe Connect not wired — hosts cannot receive payouts, blocking the referral flywheel.",
    "Stripe Connect integration pending — hosts cannot get paid.",
    "Stripe Connect unwired; hosts accumulating payouts but receiving no funds.",
    "Stripe Connect currently unwired — live host payouts blocked.",
  ])("does NOT withhold a note about the tenant's own payouts product: %s", (note) => {
    expect(contradictedConnector(note, CONNECTED)).toBeNull();
  });

  it("still catches the connector claim even when payouts are discussed elsewhere in the note", () => {
    const note =
      "Hosts are accumulating payouts. Separately, Stripe is not connected to the Praxis workspace.";
    expect(contradictedConnector(note, CONNECTED)).toBe("stripe");
  });
});

describe("withheldNoteStub", () => {
  it("tells the model WHY the claim is gone, so it doesn't infer absence", () => {
    const stub = withheldNoteStub("stripe");
    expect(stub).toContain("stripe");
    expect(stub).toMatch(/withheld/i);
    expect(stub).toMatch(/IS callable/i);
    expect(stub).toMatch(/stale/i);
  });
});

describe("redactContradictedClaims — excise the lie, KEEP the note", () => {
  const CONNECTED = ["stripe", "github"];

  it("preserves a valuable note that merely MENTIONS the stale claim", () => {
    const note =
      "The most recently reported blended take-rate is 14.1%, recorded for the week ending 2026-05-16. " +
      "This is below the P2P benchmark of ~25%, a deliberate strategic choice. " +
      "This figure is unverified because Stripe is not connected.";
    const r = redactContradictedClaims(note, CONNECTED);

    expect(r.text).toContain("blended take-rate is 14.1%");
    expect(r.text).toContain("below the P2P benchmark of ~25%");
    expect(r.text).not.toMatch(/Stripe is not connected/i);
    expect(r.text).toContain("stale claim withheld");
    expect(r.withheld).toEqual(["stripe"]);
  });

  it("leaves a clean note completely untouched (byte-for-byte)", () => {
    const note = "Bay Area campaigns live under campaign-name `rental_bayarea_intent`.";
    const r = redactContradictedClaims(note, CONNECTED);
    expect(r.text).toBe(note);
    expect(r.withheld).toEqual([]);
  });

  it("leaves the tenant's own payouts-product note untouched", () => {
    const note = "Stripe Connect not wired — hosts cannot receive payouts.";
    const r = redactContradictedClaims(note, CONNECTED);
    expect(r.text).toBe(note);
    expect(r.withheld).toEqual([]);
  });

  it("redacts every false sentence and dedupes the reported slugs", () => {
    const note =
      "Stripe is not connected. Hosts are growing. GitHub connector not wired. Stripe is disconnected.";
    const r = redactContradictedClaims(note, CONNECTED);
    expect(r.text).toContain("Hosts are growing.");
    expect(r.withheld.sort()).toEqual(["github", "stripe"]);
    expect((r.text.match(/stale claim withheld/g) ?? []).length).toBe(3);
  });

  it("no-ops when nothing is connected (no capability => no proof => no redaction)", () => {
    const note = "Stripe is not connected.";
    expect(redactContradictedClaims(note, []).text).toBe(note);
  });
});
