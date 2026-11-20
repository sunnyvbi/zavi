import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ChannelActionCard } from "../ChannelActionCard";
import { makeAction } from "../__tests__/fixtures";
import { platformFor } from "../platforms";
import { deliverableOf, exactChangeRows, type ActionHandlers, type ActionItem } from "../types";
import { AdsPresentation } from "./AdsPresentation";

const PENDING = "Paste the link to the company post when you review this draft.";
const PICK = "Pick the company post to promote when you review this draft.";
const URN = "urn:li:share:7300000000000000001";
const STORED = `https://www.linkedin.com/feed/update/${URN}/`;
const SHOWN = `https://www.linkedin.com/feed/update/${URN}`;

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onReviseAd: vi.fn(async () => true) };
}

function card(action: ActionItem) {
  const props = { action, handlers: handlers(), platform: platformFor(action.channel_slug) };
  return <AdsPresentation value={props}><ChannelActionCard {...props} /></AdsPresentation>;
}

function draftStep(preview: string) {
  return {
    title: "Review and create your LinkedIn campaign",
    body: "Set the daily budget, bid, country and the company post.",
    responsibility: "client",
    deliverable: {
      kind: "ad",
      label: "LinkedIn campaign draft",
      content: `Pilot campaign\nLinkedIn audience - 2026-10-29\n${preview}`,
      presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "Pilot campaign", group_name: "LinkedIn audience - 2026-10-29", rationale: "You started this", post_preview: preview, country: "US", language: "en" },
    },
  };
}

function failedCard(preview = PENDING) {
  return makeAction("create_ad", {
    id: "li-failed",
    channel_slug: "linkedin_ads",
    executable: true,
    exec_status: "failed",
    body: {
      step: draftStep(preview),
      exact_change: { rows: [
        { item: "Campaign", before: "Not created", after: "Pilot campaign · paused" },
        { item: "Promoted post", before: "Not chosen", after: STORED },
      ] },
    },
  } as never);
}

function draftCard(preview = PENDING) {
  return makeAction("create_ad", { id: "li-draft", channel_slug: "linkedin_ads", body: { step: draftStep(preview) } } as never);
}

function textOf(action: ActionItem) {
  const host = renderToString(card(action)).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  return host;
}

describe("failed LinkedIn campaign card with the post already chosen", () => {
  it("shows no paste-the-link prompt and shows the promoted post without a trailing slash", () => {
    const text = textOf(failedCard());
    expect(text).toContain("Pilot campaign");
    expect(text).not.toContain(PENDING);
    expect(text).not.toContain("Paste the link to the company post");
    expect(text).toContain(SHOWN);
    expect(text).not.toContain(STORED);
    expect(text).not.toMatch(/feed\/update\/urn:li:share:\d+\//);
  });

  it("drops the agent-filed pick-the-post placeholder too once the post is set", () => {
    expect(textOf(failedCard(PICK))).not.toContain(PICK);
  });

  it("keeps the prompt on a draft that has no post link yet", () => {
    expect(textOf(draftCard())).toContain(PENDING);
  });

  it("keeps a real post preview even when the post is set", () => {
    const action = failedCard("Zavi Labs launch post");
    expect(deliverableOf(action)?.content).toBe("Pilot campaign\nLinkedIn audience - 2026-10-29\nZavi Labs launch post");
  });

  it("leaves the stored rows alone and only trims the displayed URL", () => {
    const action = failedCard();
    expect(exactChangeRows(action).find((r) => r.item === "Promoted post")?.after).toBe(SHOWN);
    expect((action.body?.exact_change?.rows as Array<{ after: string }>)[1].after).toBe(STORED);
    expect(action.body?.step?.deliverable?.content).toContain(PENDING);
    const other = makeAction("update_ad", { channel_slug: "meta_ads", body: { exact_change: { rows: [{ item: "Promoted post", before: "a", after: "https://example.com/x/" }] } } });
    expect(exactChangeRows(other)[0].after).toBe("https://example.com/x/");
  });
});
