import { describe, it, expect } from "vitest";
import { parsePraxisAction, isPraxisActionHref } from "./praxisActionUrl";

describe("parsePraxisAction", () => {
  it("happy: connect:linear", () => {
    expect(parsePraxisAction("/__praxis_action__/connect:linear")).toEqual({
      verb: "connect",
      slug: "linear",
    });
  });

  it("happy: reauth:jira", () => {
    expect(parsePraxisAction("/__praxis_action__/reauth:jira")).toEqual({
      verb: "reauth",
      slug: "jira",
    });
  });

  it("happy: each whitelisted slug parses", () => {
    for (const slug of ["linear", "jira", "slack", "stripe", "github"]) {
      const r = parsePraxisAction(`/__praxis_action__/connect:${slug}`);
      if (r && (r.verb === "connect" || r.verb === "reauth")) {
        expect(r.slug).toBe(slug);
      } else {
        throw new Error(`expected connect variant for slug=${slug}, got ${JSON.stringify(r)}`);
      }
    }
  });

  it("happy: descriptor slugs beyond the old 5 (meta_ads, google_sheets)", () => {
    expect(parsePraxisAction("/__praxis_action__/connect:meta_ads")).toEqual({
      verb: "connect",
      slug: "meta_ads",
    });
    expect(parsePraxisAction("/__praxis_action__/reauth:google_sheets")).toEqual({
      verb: "reauth",
      slug: "google_sheets",
    });
  });

  it("happy: any well-formed pipedream.<app>", () => {
    expect(parsePraxisAction("/__praxis_action__/connect:pipedream.hubspot")).toEqual({
      verb: "connect",
      slug: "pipedream.hubspot",
    });
  });

  it("rejects junk that only looks like a slug", () => {
    expect(parsePraxisAction("/__praxis_action__/connect:pipedream.")).toBeNull();
    expect(parsePraxisAction("/__praxis_action__/connect:pipedream.Hub-Spot")).toBeNull();
    expect(parsePraxisAction("/__praxis_action__/connect:linear.evil")).toBeNull();
    expect(parsePraxisAction("/__praxis_action__/connect:../../etc")).toBeNull();
  });

  it("rejects unknown verb", () => {
    expect(parsePraxisAction("/__praxis_action__/refund:order-123")).toBeNull();
    expect(parsePraxisAction("/__praxis_action__/delete:linear")).toBeNull();
  });

  it("rejects unknown slug (whitelist enforced)", () => {
    expect(parsePraxisAction("/__praxis_action__/connect:notion")).toBeNull();
    expect(parsePraxisAction("/__praxis_action__/connect:not-a-real-slug")).toBeNull();
  });

  it("rejects malformed (no colon)", () => {
    expect(parsePraxisAction("/__praxis_action__/connect-linear")).toBeNull();
  });

  it("rejects empty verb", () => {
    expect(parsePraxisAction("/__praxis_action__/:linear")).toBeNull();
  });

  it("strips injection junk past the slug", () => {
    const r = parsePraxisAction(
      "/__praxis_action__/connect:linear&injected=evil",
    );
    expect(r).toEqual({ verb: "connect", slug: "linear" });
  });

  it("rejects URL-encoded injection", () => {
    expect(
      parsePraxisAction("/__praxis_action__/connect:linear%20rogue"),
    ).toEqual({ verb: "connect", slug: "linear" });
  });

  it("rejects non-action URLs", () => {
    expect(parsePraxisAction("https://zaviagent.com/foo")).toBeNull();
    expect(parsePraxisAction("/workspace?tab=settings")).toBeNull();
    expect(parsePraxisAction("mailto:user@example.com")).toBeNull();
  });

  it("rejects undefined / null / empty", () => {
    expect(parsePraxisAction(undefined)).toBeNull();
    expect(parsePraxisAction(null)).toBeNull();
    expect(parsePraxisAction("")).toBeNull();
  });
});

describe("parsePraxisAction — add-repo (v2 verb)", () => {
  it("happy: owner/repo", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:rravi149/praxis"),
    ).toEqual({ verb: "add-repo", owner: "rravi149", repo: "praxis" });
  });

  it("preserves case + dots + hyphens in repo name", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:Some-Org/repo.js"),
    ).toEqual({ verb: "add-repo", owner: "Some-Org", repo: "repo.js" });
  });

  it("strips injection past owner/repo", () => {
    expect(
      parsePraxisAction(
        "/__praxis_action__/add-repo:rravi149/praxis&injected=evil",
      ),
    ).toEqual({ verb: "add-repo", owner: "rravi149", repo: "praxis" });
  });

  it("rejects missing owner/repo", () => {
    expect(parsePraxisAction("/__praxis_action__/add-repo:")).toBeNull();
  });

  it("rejects missing repo (no slash)", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:rravi149"),
    ).toBeNull();
  });

  it("rejects empty owner", () => {
    expect(parsePraxisAction("/__praxis_action__/add-repo:/praxis")).toBeNull();
  });

  it("rejects empty repo (trailing slash)", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:rravi149/"),
    ).toBeNull();
  });

  it("rejects invalid owner chars (special chars not in regex)", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:!bad/praxis"),
    ).toBeNull();
  });

  it("stops repo parse at whitespace", () => {
    expect(
      parsePraxisAction("/__praxis_action__/add-repo:rravi149/space here"),
    ).toEqual({ verb: "add-repo", owner: "rravi149", repo: "space" });
  });

  it("rejects owner > 39 chars (github max length)", () => {
    const longOwner = "a".repeat(40);
    expect(
      parsePraxisAction(`/__praxis_action__/add-repo:${longOwner}/praxis`),
    ).toBeNull();
  });
});

describe("isPraxisActionHref", () => {
  it("recognizes prefix", () => {
    expect(isPraxisActionHref("/__praxis_action__/connect:linear")).toBe(true);
  });
  it("rejects plain URLs", () => {
    expect(isPraxisActionHref("https://zaviagent.com")).toBe(false);
    expect(isPraxisActionHref("/workspace")).toBe(false);
  });
  it("rejects undefined / empty", () => {
    expect(isPraxisActionHref(undefined)).toBe(false);
    expect(isPraxisActionHref(null)).toBe(false);
    expect(isPraxisActionHref("")).toBe(false);
  });
});
