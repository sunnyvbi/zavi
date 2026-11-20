
import { describe, it, expect } from "vitest";
import { channelsDue } from "@/services/channels/due";
describe("what the new capsules do to the sweep", () => {
  it("linkedin_ads and sms can NEVER be scheduled, for any tenant", () => {
    const all = new Set(["google_ads","meta_ads","google_analytics","email"]);
    const due = channelsDue([], all, Date.now(), 100, true);
    expect(due).not.toContain("linkedin_ads");
    expect(due).not.toContain("sms");
  });
  it("youtube_ads is due only when google_ads is linked", () => {
    expect(channelsDue([], new Set(["google_ads"]), Date.now(), 100, true)).toContain("youtube_ads");
    expect(channelsDue([], new Set(), Date.now(), 100, true)).not.toContain("youtube_ads");
  });
  it("email_marketing is due only when the email connection exists", () => {
    expect(channelsDue([], new Set(["email"]), Date.now(), 100, true)).toContain("email_marketing");
    expect(channelsDue([], new Set(), Date.now(), 100, true)).not.toContain("email_marketing");
  });
  it("reddit_ads can NEVER be scheduled, for any tenant", () => {
    const all = new Set(["google_ads","meta_ads","google_analytics","email","reddit_social"]);
    expect(channelsDue([], all, Date.now(), 100, true)).not.toContain("reddit_ads");
    expect(channelsDue([], new Set(), Date.now(), 100, true)).not.toContain("reddit_ads");
  });

  it("chatgpt_ads can NEVER be scheduled, for any tenant", () => {
    const all = new Set(["google_ads","meta_ads","google_analytics","email","reddit_social"]);
    expect(channelsDue([], all, Date.now(), 100, true)).not.toContain("chatgpt_ads");
    expect(channelsDue([], new Set(), Date.now(), 100, true)).not.toContain("chatgpt_ads");
  });

  it("a tenant with NO connectors gains no new scheduled channel", () => {
    const due = channelsDue([], new Set(), Date.now(), 100, true);
    for (const s of ["youtube_ads","linkedin_ads","email_marketing","sms"]) {
      expect(due, `${s} must not fire with zero connectors`).not.toContain(s);
    }
  });
});

describe("reddit_organic scheduling", () => {
  it("is due with NO linked connector, on public evidence alone", () => {
    expect(channelsDue([], new Set(), Date.now(), 100, true)).toContain("reddit_organic");
  });

  it("is NOT due for a tenant with no marketing site, because step one reads their site", () => {
    expect(channelsDue([], new Set(), Date.now(), 100, false)).not.toContain("reddit_organic");
  });
});
