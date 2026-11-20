import { describe, expect, it } from "vitest";
import { BRIEF_LEAD_MAX, BRIEF_TITLE_MAX, cardBrief, clip } from "../card-brief";
import { toActionView } from "../channel-actions";

const long = "Raise the daily budget on the Spring promo campaign because it keeps hitting the cap before noon while cost per conversion stays well under target across every ad set";

describe("cardBrief", () => {
  it("keeps a short title as it is", () => {
    expect(cardBrief({ title: "Pause 4 keywords" }).title).toBe("Pause 4 keywords");
  });

  it("cuts a long title to its first clause or a word boundary", () => {
    const t = cardBrief({ title: `Fix the sitemap: ${long}` }).title;
    expect(t).toBe("Fix the sitemap");
    const c = cardBrief({ title: long }).title;
    expect(c.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    expect(c.endsWith("…")).toBe(true);
  });

  it("splits prose into a short lead and list lines into at most three points", () => {
    const b = cardBrief({
      title: "Update the bio",
      stepBody: `Your bio has no link. People who read it cannot find the site. ${long}.\n- Add the link\n- Name the city\n* Say what it costs\n1. Pin a post`,
    });
    expect(b.lead).toBe("Your bio has no link. People who read it cannot find the site.");
    expect(b.points).toEqual(["Add the link", "Name the city", "Say what it costs"]);
  });

  it("clips one very long sentence", () => {
    const b = cardBrief({ title: "t", stepBody: `${long} ${long}.` });
    expect(b.lead!.length).toBeLessThanOrEqual(BRIEF_LEAD_MAX);
  });

  it("keeps three how-to steps without markdown", () => {
    expect(cardBrief({ title: "t", howTo: ["1. **Read** it.", "Press [Post](https://x.com).", "Check it.", "Fourth"] }).steps).toEqual(["Read it.", "Press Post.", "Check it."]);
  });

  it("clip never splits mid-word when a space is near", () => {
    expect(clip("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });
});

describe("brief on the wire", () => {
  it("toActionView attaches a brief built from the served title and body", () => {
    const view = toActionView({
      id: "ca-1", channel_slug: "x_organic", run_id: "run-1", position: 1, run_of: 1, blocking: false,
      action_type: "text_post", title: "Post the launch thread",
      body: { step: { title: "t", body: "Your launch is tomorrow. Post this now.\n- Thread of 3" } },
      status: "pending", note: null, snoozed_until: null, impact: null, impact_reason: null,
      proposed_at: "2026-11-01T00:00:00Z", repeat_of: null, redo_of: null,
    } as never, 0, null);
    expect(view.brief).toEqual({ title: "Post the launch thread", lead: "Your launch is tomorrow. Post this now.", points: ["Thread of 3"], steps: [] });
  });

  it("does not put a removed email audience count back into the brief", () => {
    const view = toActionView({
      id: "ca-email", channel_slug: "email_marketing", run_id: "run-1", position: 1, run_of: 1, blocking: false,
      action_type: "send_message", title: "Send the campaign",
      body: { step: { title: "t", body: 'Zavi sends this to your "Customers" list, 1,204 people today. Klaviyo applies its own unsubscribes.' } },
      status: "pending", note: null, snoozed_until: null, impact: null, impact_reason: null,
      proposed_at: "2026-11-01T00:00:00Z", repeat_of: null, redo_of: null,
      exec_class: "email_campaign.create_and_send",
    } as never, 0, null);
    expect(JSON.stringify(view.body)).not.toContain("1,204 people today");
    expect(JSON.stringify(view.brief)).not.toContain("1,204 people today");
  });
});
