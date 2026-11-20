import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposioWriteCardView, type ComposioDecisionRow } from "./ApprovalBlock";

const row: ComposioDecisionRow = {
  id: "44444444-4444-4444-8444-444444444444",
  decision_class: "composio.moves_money",
  handler: "composio.execute_tool",
  status: "proposed",
  dispatched_at: null,
  dispatch_error: null,
  body: {
    app_name: "Reddit Ads",
    action: "Update campaign",
    arguments: { campaign_id: "2608771992000159284", data: { configured_status: "ACTIVE" } },
    labels: ["moves_money"],
    fingerprint: "a".repeat(64),
  },
};

describe("Reddit Ads campaign approval roles", () => {
  it.each(["owner", "admin", "member", "viewer"] as const)("renders the correct approve permission for %s", (viewerRole) => {
    const html = renderToStaticMarkup(
      <ComposioWriteCardView
        decisionId={row.id}
        title="Reddit Ads: Update campaign"
        row={row}
        loadError={null}
        viewerRole={viewerRole}
        busy={false}
        actionError={null}
        onApprove={() => {}}
        onReject={() => {}}
        now={Date.parse("2026-10-09T12:00:00Z")}
      />,
    );
    const hasApprove = />Approve<\/button>/.test(html);
    expect(hasApprove).toBe(viewerRole === "owner" || viewerRole === "admin");
    expect(html).toContain("Reddit Ads: Update campaign");
    if (viewerRole === "member") expect(html).toContain("Only an owner or admin can approve this");
  });
});
