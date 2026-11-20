import { describe, it, expect } from "vitest";
import { sortBoard, topGap, subscores, type BoardRow, type Lane } from "../board";

function row(over: Partial<BoardRow> & { slug: string }): BoardRow {
  return {
    tenant_id: `id-${over.slug}`,
    display_name: null,
    company_shape: null,
    score: 50,
    dimensions: {},
    subscores: null,
    computed_at: "2026-07-13T00:00:00Z",
    last_discovery_at: null,
    lane: "act" as Lane,
    top_gap: null,
    connector_gap: false,
    agent_addressable: false,
    park_reason: "parked",
    plan: null,
    sub_status: null,
    paying: false,
    grandfathered: false,
    churn_signal: null,
    traction: { status: "absent" },
    fde_touches: 0,
    last_fde_touch_at: null,
    ...over,
  };
}

describe("topGap", () => {
  it("picks the dimension with the biggest missing chunk of score", () => {
    const gap = topGap({ connectors: 12, verified_brain: 16, product_url: 10 });
    expect(gap).toBe("connectors");
  });

  it("breaks a tie toward the higher-value dimension", () => {
    const gap = topGap({ connectors: 20, goal_measurable: 5 });
    expect(gap).toBe("connectors");
  });

  it("returns null when nothing is missing (a full-marks tenant has no gap)", () => {
    expect(
      topGap({
        connectors: 30,
        verified_brain: 20,
        goal_measurable: 15,
        deliverable: 15,
        product_url: 10,
        founder_engaged: 10,
      }),
    ).toBeNull();
  });

  it("returns null — not a guess — when there are no dimensions at all", () => {
    expect(topGap(null)).toBeNull();
  });
});

describe("sortBoard — lane precedence", () => {
  it("puts ACT (only-a-human-can-move-it) above every other lane", () => {
    const out = sortBoard([
      row({ slug: "operable-tenant", lane: "operable", score: 85 }),
      row({ slug: "nurture-tenant", lane: "nurture", score: 60, agent_addressable: true }),
      row({ slug: "act-tenant", lane: "act", score: 40 }),
      row({ slug: "unscored-tenant", lane: "unscored", score: null }),
    ]);
    expect(out.map((r) => r.slug)).toEqual([
      "act-tenant",
      "nurture-tenant",
      "unscored-tenant",
      "operable-tenant",
    ]);
  });

  it("an UNSCORED tenant never outranks a real ACT tenant — absence of a score is not a score of 0", () => {
    const out = sortBoard([
      row({ slug: "never-scanned", lane: "unscored", score: null }),
      row({ slug: "genuinely-stuck", lane: "act", score: 35 }),
    ]);
    expect(out[0].slug).toBe("genuinely-stuck");
    expect(out[1].score).toBeNull();
  });
});

describe("sortBoard — ACT lane ordering", () => {
  it("ranks a connector gap above a non-connector gap (biggest recoverable score)", () => {
    const out = sortBoard([
      row({ slug: "brain-gap", top_gap: "verified_brain", connector_gap: false, score: 50 }),
      row({ slug: "connector-gap", top_gap: "connectors", connector_gap: true, score: 50 }),
    ]);
    expect(out[0].slug).toBe("connector-gap");
  });

  it("ranks a genuinely paying tenant above a grandfathered one", () => {
    const out = sortBoard([
      row({ slug: "grandfathered-full", plan: "full", paying: false, grandfathered: true }),
      row({ slug: "real-paying", plan: "team", paying: true, grandfathered: false }),
    ]);
    expect(out[0].slug).toBe("real-paying");
  });

  it("ranks a paying tenant with a churn signal above a healthy paying one", () => {
    const out = sortBoard([
      row({ slug: "healthy", paying: true, churn_signal: null }),
      row({ slug: "leaving", paying: true, churn_signal: "past_due" }),
    ]);
    expect(out[0].slug).toBe("leaving");
  });

  it("ranks the tenant closest to the gate first when all else is equal", () => {
    const out = sortBoard([
      row({ slug: "far", score: 20 }),
      row({ slug: "nearly-there", score: 65 }),
    ]);
    expect(out[0].slug).toBe("nearly-there");
  });
});

describe("sortBoard — the fairness floor", () => {
  it("puts a never-touched tenant ahead of one a human has already rescued", () => {
    const out = sortBoard([
      row({ slug: "already-helped", fde_touches: 3, last_fde_touch_at: "2026-07-12T00:00:00Z" }),
      row({ slug: "never-touched", fde_touches: 0, last_fde_touch_at: null }),
    ]);
    expect(out[0].slug).toBe("never-touched");
  });

  it("rotates: among equally-ranked tenants, the least-recently-touched comes first", () => {
    const out = sortBoard([
      row({ slug: "touched-yesterday", fde_touches: 1, last_fde_touch_at: "2026-07-12T00:00:00Z" }),
      row({ slug: "touched-last-month", fde_touches: 1, last_fde_touch_at: "2026-06-10T00:00:00Z" }),
    ]);
    expect(out[0].slug).toBe("touched-last-month");
  });

  it("does not let the fairness floor override a real priority signal", () => {
    const out = sortBoard([
      row({ slug: "free-never-touched", paying: false, fde_touches: 0, last_fde_touch_at: null }),
      row({
        slug: "paying-touched-yesterday",
        paying: true,
        fde_touches: 1,
        last_fde_touch_at: "2026-07-12T00:00:00Z",
      }),
    ]);
    expect(out[0].slug).toBe("paying-touched-yesterday");
  });
});

describe("subscores — agent-doable vs human-doable split", () => {
  it("splits the six dimensions into a 45pt agent half and a 55pt human half", () => {
    const s = subscores({});
    expect(s.agent_doable_max).toBe(45);
    expect(s.human_doable_max).toBe(55);
  });

  it("agent_complete is true only when EVERY agent-doable dim is at full marks", () => {
    const partial = subscores({ verified_brain: 8, product_url: 10, deliverable: 15 });
    expect(partial.agent_complete).toBe(false);
    expect(partial.agent_doable_score).toBe(33);

    const full = subscores({ verified_brain: 20, product_url: 10, deliverable: 15 });
    expect(full.agent_complete).toBe(true);
  });

  it("lists exactly the human-doable dimensions still carrying a deficit — the human to-do", () => {
    const s = subscores({
      verified_brain: 20,
      product_url: 10,
      deliverable: 15,
      connectors: 0,
      goal_measurable: 0,
      founder_engaged: 0,
    });
    expect(s.agent_complete).toBe(true);
    expect(s.human_blockers).toEqual(["connectors", "goal_measurable", "founder_engaged"]);
  });

  it("a missing dimension counts as 0 earned — never silently 'done'", () => {
    const s = subscores({ product_url: 10, deliverable: 15 });
    expect(s.agent_doable_score).toBe(25);
    expect(s.agent_complete).toBe(false);
  });
});
