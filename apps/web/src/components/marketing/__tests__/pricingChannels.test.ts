import { describe, expect, it } from "vitest";
import { PRICING_CONFIG } from "@zavi/shared";
import { readChannelLine } from "@/components/marketing/pricingChannels";

describe("readChannelLine", () => {
  it("strips a Coming soon marker and keeps the channel name", () => {
    const r = readChannelLine("TikTok - Organic - Coming soon");
    expect(r.comingSoon).toBe(true);
    expect(r.label).toBe("TikTok - Organic");
    expect(r.mark).not.toBeNull();
  });

  it("does not confuse an ads channel with its organic namesake", () => {
    expect(readChannelLine("X Ads - Coming soon").mark).toBe(
      readChannelLine("X - Organic").mark,
    );
    expect(readChannelLine("X Ads - Coming soon").label).toBe("X Ads");
    expect(readChannelLine("X - Organic").comingSoon).toBe(false);
  });

  it("matches a distinct mark per brand", () => {
    expect(readChannelLine("Meta Ads").mark).not.toBe(readChannelLine("Google/YouTube Ads").mark);
    expect(readChannelLine("Instagram").mark).not.toBeNull();
    expect(readChannelLine("AI Answers (GEO)").mark).not.toBeNull();
    expect(readChannelLine("Reddit").mark).not.toBeNull();
  });

  it("draws a mark for every channel the pricing config sells", () => {
    const names = PRICING_CONFIG.features.flatMap((f) => (f.channels ?? []).map((c) => c.name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect({ name, mark: readChannelLine(name).mark !== null }).toEqual({ name, mark: true });
    }
  });

  it("normalises en/em dashes", () => {
    expect(readChannelLine("LinkedIn – Organic").mark).not.toBeNull();
    expect(readChannelLine("LinkedIn — Organic").mark).not.toBeNull();
  });

  it("is TOTAL: an unknown line keeps its text and renders plainly", () => {
    const r = readChannelLine("48,000 credits per month, plus 1,000 free credits every day");
    expect(r.mark).toBeNull();
    expect(r.comingSoon).toBe(false);
    expect(r.label).toBe("48,000 credits per month, plus 1,000 free credits every day");
  });

  it("never drops text for a line the backend adds later", () => {
    for (const line of ["Something Brand New", "Everything in Free", "Engineer and fundraising agents", ""]) {
      expect(readChannelLine(line).label).toBe(line);
    }
  });

  it("treats a trailing-colon lead-in as a heading, not a feature", () => {
    for (const h of ["Everything in Free, plus:", "Everything in Starter, plus:", "Everything in Growth, plus:"]) {
      const r = readChannelLine(h);
      expect(r.heading).toBe(true);
      expect(r.mark).toBeNull();
      expect(r.comingSoon).toBe(false);
      expect(r.label).toBe(h);
    }
  });

  it("does not mistake a channel for a heading", () => {
    expect(readChannelLine("Instagram").heading).toBe(false);
    expect(readChannelLine("X Ads - Coming soon").heading).toBe(false);
    expect(readChannelLine("Website Analysis").heading).toBe(false);
  });
});
