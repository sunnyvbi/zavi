
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TriageReviewer } from "../TriageReviewer";
import type { TriageBucket } from "@/components/agents/triageNav";

function dec(id: string, token: string) {
  return {
    id,
    decision_class: "meta_ads.set_status",
    handler: "meta_ads.set_status",
    body: { status: "PAUSED", level: "campaign", rationale: `${token} ROAS 0.4x for 7 days.` },
    status: "proposed",
    emitted_at: "2026-06-20T00:00:00Z",
  };
}

const BUCKETS: TriageBucket[] = [
  { key: "pause", label: "Pausing", items: [dec("a", "CampaignAlpha"), dec("b", "CampaignBeta")] },
  { key: "budget_up", label: "Raising", items: [dec("c", "CampaignGamma")] },
];

const noop = () => {};
const noopSetter = (() => {}) as unknown as React.Dispatch<React.SetStateAction<string | null>>;

const html = renderToStaticMarkup(
  <TriageReviewer
    buckets={BUCKETS}
    total={3}
    modifyingId={null}
    setModifyingId={noopSetter}
    armReject={noop}
    load={async () => {}}
    refetchProposals={async () => []}
    postDecision={async () => ({ ok: true })}
  />,
);

describe("TriageReviewer — focused single-card surface", () => {
  it("renders the Approve Now header with the total", () => {
    expect(html).toContain("Approve Now (3)");
  });

  it("shows the progress rail (1 of 3) and the current bucket label", () => {
    expect(html).toContain("1 of 3");
    expect(html).toContain("Pausing");
  });

  it("renders only the FIRST proposal, not all three at once", () => {
    expect(html).toContain("CampaignAlpha");
    expect(html).not.toContain("CampaignBeta");
    expect(html).not.toContain("CampaignGamma");
  });

  it("offers Approve / Reject / Modify on the focused card", () => {
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Modify");
  });

  it("surfaces the keyboard affordances (discoverable, not hidden)", () => {
    expect(html).toContain("approve");
    expect(html).toContain("reject");
    expect(html).toContain("modify");
    expect(html).toContain("Prev");
    expect(html).toContain("Next");
  });

  it("renders nothing when there are no proposals", () => {
    const empty = renderToStaticMarkup(
      <TriageReviewer
        buckets={[]}
        total={0}
        modifyingId={null}
        setModifyingId={noopSetter}
        armReject={noop}
        load={async () => {}}
        refetchProposals={async () => []}
        postDecision={async () => ({ ok: true })}
      />,
    );
    expect(empty).toBe("");
  });
});
