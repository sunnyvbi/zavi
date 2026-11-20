import { describe, expect, it } from "vitest";
import { actionLabel } from "../action-label";

describe("actionLabel", () => {
  it("is a fixed word per action type", () => {
    expect(actionLabel({ action_type: "pause_ad", title: "Pause 4 keywords with no conversions in 60 days" })).toBe("Pause");
    expect(actionLabel({ action_type: "update_ad", title: "Raise the budget on the capped campaign" })).toBe("Apply change");
    expect(actionLabel({ action_type: "create_ad", title: "Add a campaign for high-intent searches" })).toBe("Create ad");
    expect(actionLabel({ action_type: "check", title: "Check why mobile signups dropped" })).toBe("Do it");
    expect(actionLabel({ action_type: "fix", title: "Fix the meta robots tag" })).toBe("Fix it");
    expect(actionLabel({ action_type: "setup", title: "Claim your business profile" })).toBe("Set it up");
    expect(actionLabel({ action_type: "page", title: "Rewrite the pricing page title" })).toBe("Open the page");
    expect(actionLabel({ action_type: "send_message", title: "Send the win-back email" })).toBe("Send it");
    expect(actionLabel({ action_type: "other", title: "Anything else" })).toBe("Do it");
  });

  it("ignores the title completely — the same type always gives the same word", () => {
    const a = actionLabel({ action_type: "check", title: "Check why mobile signups dropped" });
    const b = actionLabel({ action_type: "check", title: "campaign_id 120259468814150059 needs a look" });
    const c = actionLabel({ action_type: "check", title: "" });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("Do it");
  });

  it("names a budget change, because the rows say so unambiguously", () => {
    expect(
      actionLabel({
        action_type: "update_ad",
        title: "Anything at all",
        rows: [{ item: "Daily budget", before: "$40", after: "$55" }],
      }),
    ).toBe("Adjust budget");
  });

  it("does not call something a budget change when no row names a budget", () => {
    expect(
      actionLabel({
        action_type: "update_ad",
        title: "Raise the budget on the capped campaign",
        rows: [{ item: "Headline", before: "A", after: "B" }],
      }),
    ).toBe("Apply change");
  });

  it("returns the EXACT string for every action type, never just something truthy", () => {
    const expected: Record<string, string> = {
      text_post: "Post it",
      image_post: "Post it",
      video_post: "Post it",
      reply: "Reply",
      send_message: "Send it",
      create_ad: "Create ad",
      update_ad: "Apply change",
      pause_ad: "Pause",
      fix: "Fix it",
      check: "Do it",
      setup: "Set it up",
      page: "Open the page",
      other: "Do it",
    };
    for (const [type, word] of Object.entries(expected)) {
      expect(actionLabel({ action_type: type, title: "irrelevant" }), type).toBe(word);
    }
  });

  it("falls back to a real word for an action type from a newer server", () => {
    expect(actionLabel({ action_type: "launch_rocket", title: "x" })).toBe("Do it");
  });

  it("keeps 'Create ad' on a create, which also lists a Daily budget row", () => {
    expect(
      actionLabel({
        action_type: "create_ad",
        title: "Open the brand campaign",
        rows: [
          { item: "Campaign", before: "None", after: "Brand" },
          { item: "Daily budget", before: "None", after: "$40/day" },
          { item: "Status", before: "None", after: "Created paused" },
        ],
      }),
    ).toBe("Create ad");
  });

  it("keeps 'Pause' on a pause of something whose NAME contains budget", () => {
    expect(
      actionLabel({
        action_type: "pause_ad",
        title: "Pause the brand campaign",
        rows: [{ item: "Brand budget", before: "Enabled", after: "Paused" }],
      }),
    ).toBe("Pause");
  });

  it("still names a real budget change on an update", () => {
    expect(
      actionLabel({
        action_type: "update_ad",
        title: "Raise the cap",
        rows: [{ item: "Campaign daily budget", before: "$40/day", after: "$55/day" }],
      }),
    ).toBe("Adjust budget");
  });
});

describe("a removal is labelled Remove, never Pause", () => {
  it("reads the server-built removal row", () => {
    expect(
      actionLabel({
        action_type: "pause_ad",
        title: "Remove the paused E2E test campaign",
        rows: [{ item: "“Zavi · Zavi E2E Test”", before: "In your account", after: "Removed for good" }],
      }),
    ).toBe("Remove");
  });

  it("a campaign named Removed for good is still created, not removed", () => {
    expect(
      actionLabel({
        action_type: "create_ad",
        title: "Create a campaign",
        rows: [{ item: "Campaign", before: "None", after: "Removed for Good" }],
      }),
    ).toBe("Create ad");
  });

  it("keeps Pause for a real pause", () => {
    expect(actionLabel({ action_type: "pause_ad", title: "Pause X", rows: [{ item: "Ad set X", before: "Active", after: "Paused" }] })).toBe("Pause");
  });
});

describe("removal exec classes", () => {
  it("say Remove whatever the rows say", async () => {
    const { actionLabel } = await import("../action-label");
    for (const exec_class of ["google_ads.remove_resource", "meta_ads.delete_campaign", "reddit_ads.remove_object", "tiktok_ads.delete_campaign"]) {
      expect(actionLabel({ action_type: "pause_ad", title: "", rows: null, exec_class })).toBe("Remove");
    }
    expect(actionLabel({ action_type: "pause_ad", title: "", rows: null, exec_class: "meta_ads.set_status" })).toBe("Pause");
  });
});
