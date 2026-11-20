
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalBlock, ComposioWriteCardView, type DecisionBody } from "./ApprovalBlock";

const ENRICHED: DecisionBody = {
  decision_id: "11111111-1111-4111-8111-111111111111",
  decision_class: "meta_ads.update_ad_set_budget_review",
  title: "Budget change: $72/day → $144/day",
  summary: "Confirm this budget change — tap below to apply.",
  subject: "act_123_adset_999",
  before_usd: 72,
  after_usd: 144,
};

const PLAIN: DecisionBody = {
  decision_id: "22222222-2222-4222-8222-222222222222",
  decision_class: "engineer.open_pr",
  title: "[P2] Open PR for fix — engineer",
};

describe("ApprovalBlock — enriched inline confirm card", () => {
  const html = renderToStaticMarkup(<ApprovalBlock body={ENRICHED} />);

  it("renders the campaign subject + before→after budget delta", () => {
    expect(html).toContain("act_123_adset_999");
    expect(html).toContain("$72/day");
    expect(html).toContain("$144/day");
  });

  it("renders the short confirm summary", () => {
    expect(html).toContain("Confirm this budget change");
  });

  it("offers a one-tap Confirm (not 'Approve') + a Dismiss", () => {
    expect(html).toContain("Confirm");
    expect(html).toContain("Dismiss");
  });

  it("does NOT show an Open in Needs you redirect-out", () => {
    expect(html).not.toContain("Open in Needs you");
  });
});

describe("ApprovalBlock — plain /approvals-style card (back-compat)", () => {
  const html = renderToStaticMarkup(<ApprovalBlock body={PLAIN} />);

  it("keeps Approve/Reject and links nowhere dead (no Approvals tab, never Memory Inbox)", () => {
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).not.toContain("tab=approvals");
    expect(html).not.toContain("/inbox");
  });

  it("renders the title", () => {
    expect(html).toContain("Open PR for fix");
  });
});

describe("ApprovalBlock — a Composio write is approved only from its full card (spec 12, addendum 3)", () => {
  const COMPOSIO: DecisionBody = {
    decision_id: "33333333-3333-4333-8333-333333333333",
    decision_class: "composio.moves_money",
    title: "Square: Create refund",
  };
  const html = renderToStaticMarkup(<ApprovalBlock body={COMPOSIO} onReview={() => {}} />);
  it("never offers a blind Approve/Confirm while the full card is not on screen", () => {
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Confirm<");
    expect(html).toContain("Loading the action");
  });
});

describe("ApprovalBlock — an X Ads change asked for in chat", () => {
  const X_ADS: DecisionBody = {
    decision_id: "44444444-4444-4444-8444-444444444444",
    decision_class: "x_ads.set_status",
    title: "X Ads: pause a campaign",
    summary: "Nothing changes in X Ads until you approve.",
  };

  it("loads the decision row before offering Approve", () => {
    const html = renderToStaticMarkup(<ApprovalBlock body={X_ADS} />);
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Confirm<");
    expect(html).toContain("Loading the action");
  });

  it("shows the change, the money at stake and every before/after row, then Approve/Reject", () => {
    const html = renderToStaticMarkup(
      <ComposioWriteCardView
        decisionId={X_ADS.decision_id}
        title={X_ADS.title}
        row={{
          id: X_ADS.decision_id,
          decision_class: "x_ads.set_status",
          handler: "x_ads.set_status",
          status: "proposed",
          dispatched_at: null,
          dispatch_error: null,
          body: {
            name: "Spring promo",
            status: "PAUSED",
            currency: "USD",
            daily_budget: 40,
            summary: "Pause Spring promo.",
            exact_change: { rows: [{ item: "Status", before: "Active", after: "Paused" }] },
          },
        }}
        loadError={null}
        viewerRole="owner"
        busy={false}
        actionError={null}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(html).toContain("Pause this X campaign");
    expect(html).toContain("−$40/day");
    expect(html).toContain("Active → Paused");
    expect(html).toContain("Pause Spring promo.");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
  });
});

describe("ApprovalBlock — a channel card shown in a chat (bug #14)", () => {
  const body: DecisionBody = {
    decision_id: "7a44c502-0000-4000-8000-000000000003",
    decision_class: "channel.recipe_step",
    title: "Block 7 competitor search terms",
    full_card: true,
    store: "channel_action",
    channel_slug: "google_ads",
  };
  it("names the card and opens it on its channel tile in one tap; nothing is approved from the chat", () => {
    const html = renderToStaticMarkup(<ApprovalBlock body={body} />);
    expect(html).toContain("Block 7 competitor search terms");
    expect(html).toContain("Waiting for you on the Google Ads channel page.");
    expect(html).toContain(`href="/workspace?tab=channels&amp;channel=google_ads&amp;action=${body.decision_id}"`);
    expect(html).not.toMatch(/>Approve</);
  });
  it("an AI UGC card is worked in the chat itself, not sent to the channel page", () => {
    const html = renderToStaticMarkup(<ApprovalBlock body={{ ...body, channel_slug: "generated_video" }} />);
    expect(html).toContain("chat-video-card");
    expect(html).not.toContain("channel-card-in-chat");
    expect(html).not.toContain("channel page");
  });
  it("must-not-touch: a decisions full card still renders the live decision card", () => {
    const html = renderToStaticMarkup(<ApprovalBlock body={{ ...body, store: undefined, channel_slug: undefined, decision_class: "google_ads.update_campaign_budget_review" }} />);
    expect(html).not.toContain("channel-card-in-chat");
  });
});
