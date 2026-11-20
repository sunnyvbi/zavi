
import { describe, it, expect } from "vitest";
import {
  resolveWorkspaceSegment,
  gettingStartedCopy,
  stackCopy,
  type ScaleSegment,
} from "./segmentCopy";

describe("resolveWorkspaceSegment", () => {
  it("'fresh' intent → fresh_build posture", () => {
    expect(resolveWorkspaceSegment("fresh")).toBe("fresh_build");
  });
  it("'existing' intent → has_product posture", () => {
    expect(resolveWorkspaceSegment("existing")).toBe("has_product");
  });
});

describe("fresh-build tenant: NO connector push (rule #1)", () => {
  const segments: Array<ScaleSegment | ""> = ["", "pre_revenue", "early", "scaling", "mature"];

  for (const seg of segments) {
    it(`stackCopy('fresh', '${seg}') does not push connectors`, () => {
      const c = stackCopy("fresh", seg);
      expect(c.showConnectorPush).toBe(false);
    });

    it(`stackCopy('fresh', '${seg}') empty line never says "connect a data source / Stripe / Slack"`, () => {
      const c = stackCopy("fresh", seg);
      expect(c.emptyValueLine.toLowerCase()).not.toMatch(/connect (a data source|stripe|slack|your)/);
    });

    it(`gettingStartedCopy('fresh', '${seg}') milestones are build-shaped, never "connect a data source"`, () => {
      const c = gettingStartedCopy("fresh", seg);
      expect(c.milestones).not.toContain("Connect a data source");
      expect(c.milestones.join(" ").toLowerCase()).toMatch(/describe|build|refine|preview/);
    });
  }
});

describe("has-product tenant: each scale band renders its lead framing (rule #2)", () => {
  it("pre_revenue → demand-engine framing (first customers)", () => {
    expect(gettingStartedCopy("existing", "pre_revenue").railLabel.toLowerCase()).toMatch(
      /first customers/,
    );
    expect(stackCopy("existing", "pre_revenue").emptyValueLine.toLowerCase()).toMatch(
      /demand|customers/,
    );
    expect(stackCopy("existing", "pre_revenue").showConnectorPush).toBe(true);
  });

  it("early → demand-engine framing (0→$1M)", () => {
    expect(gettingStartedCopy("existing", "early").railLabel.toLowerCase()).toMatch(/\$1m|first/);
    expect(stackCopy("existing", "early").emptyValueLine.toLowerCase()).toMatch(/demand|growth/);
  });

  it("scaling → operational-leverage framing (run your ops)", () => {
    expect(gettingStartedCopy("existing", "scaling").railLabel.toLowerCase()).toMatch(
      /ops|without hiring/,
    );
    expect(stackCopy("existing", "scaling").emptyValueLine.toLowerCase()).toMatch(
      /ops|support|finance/,
    );
  });

  it("mature → control/trust framing FIRST (approvals / audit / RBAC)", () => {
    const gs = gettingStartedCopy("existing", "mature");
    expect(gs.milestones[0].toLowerCase()).toMatch(/approval|polic/);
    expect(gs.railLabel.toLowerCase()).toMatch(/safely|control|trust/);
    expect(stackCopy("existing", "mature").emptyValueLine.toLowerCase()).toMatch(
      /approval|logged|reviewable|control/,
    );
  });

  it("each band's lead label is DISTINCT (segments don't collapse to one framing)", () => {
    const labels = (["pre_revenue", "early", "scaling", "mature"] as ScaleSegment[]).map(
      (s) => gettingStartedCopy("existing", s).railLabel,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("unset segment ('') → neutral has-product copy with connectors still pushed", () => {
    const c = stackCopy("existing", "");
    expect(c.showConnectorPush).toBe(true);
    expect(c.emptyValueLine).toMatch(/Connect Slack or GitHub/);
    expect(gettingStartedCopy("existing", "").milestones).toContain("Connect a data source");
  });
});
