import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  SOCIAL_CHANNEL_ACTIONS,
  socialChannelAvailabilityLine,
  stageableChannelProse,
  vendorBlockedChannelProse,
  unavailableChannelProse,
} from "@/services/connectors/social-channels";
import { SOCIAL_PUBLISH_HANDOFF_INSTRUCTION } from "../generic-dispatcher";

const line = () => socialChannelAvailabilityLine();

describe("BUG 5 — the fleet-wide line tracks the committed map", () => {
  it("the prompt ships EXACTLY the derived text", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toContain(line());
  });

  it("SOURCE-LEVEL: the prompt CALLS the derivation, it does not inline a literal", () => {
    const src = readFileSync(
      join(__dirname, "../generic-dispatcher.ts"),
      "utf8",
    );
    const block = src.slice(
      src.indexOf("export const SOCIAL_PUBLISH_HANDOFF_INSTRUCTION = ["),
    );
    const instruction = block.slice(0, block.indexOf('].join("\n");'));
    expect(instruction).toContain("socialChannelAvailabilityLine()");
    expect(instruction).not.toMatch(/"- Channels (available|you can STAGE)/);
    expect(instruction).not.toMatch(/are NOT available at all[^"]*"/);
  });

  it("drops the stale sentence that shipped the bug", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).not.toMatch(
      /X, LinkedIn company pages, Instagram and YouTube are NOT available/,
    );
    expect(line()).not.toMatch(/Channels available today/);
  });
});

describe("BUG 5 — it distinguishes the three states that actually exist", () => {
  it("STAGEABLE lists every enabled channel, including Instagram and YouTube", () => {
    expect(SOCIAL_CHANNEL_ACTIONS.instagram_image.enabled).toBe(true);
    expect(SOCIAL_CHANNEL_ACTIONS.youtube_video.enabled).toBe(true);
    expect(stageableChannelProse()).toMatch(/Instagram/);
    expect(stageableChannelProse()).toMatch(/YouTube/);
    expect(stageableChannelProse()).toMatch(/LinkedIn/);
    expect(stageableChannelProse()).toMatch(/Reddit/);
  });

  it("never claims staging equals publishing", () => {
    expect(line()).toMatch(/Staging is not publishing/i);
    expect(line()).toMatch(/Social publishing isn't enabled for your account yet/);
    expect(line()).toMatch(/Never promise that approval will put the post online/i);
  });

  it("derives the vendor-blocked clause from the map, and drops it when nothing is blocked", () => {
    expect(vendorBlockedChannelProse()).toMatch(/TikTok/);
    expect(line()).toMatch(/Blocked on OUR side, not the operator's/);
    expect(line()).toMatch(/Do NOT tell them to connect these in Settings/);

    const saved = Object.entries(SOCIAL_CHANNEL_ACTIONS)
      .filter(([, a]) => (a as { vendor_review_pending?: string }).vendor_review_pending)
      .map(([ch, a]) => [ch, (a as { vendor_review_pending?: string }).vendor_review_pending!] as const);
    expect(saved.length).toBeGreaterThan(0);
    try {
      for (const [ch] of saved) {
        delete (SOCIAL_CHANNEL_ACTIONS[ch] as { vendor_review_pending?: string }).vendor_review_pending;
      }
      expect(vendorBlockedChannelProse()).toBe("");
      expect(line()).not.toMatch(/Blocked on OUR side/);
    } finally {
      for (const [ch, v] of saved) {
        (SOCIAL_CHANNEL_ACTIONS[ch] as { vendor_review_pending?: string }).vendor_review_pending = v;
      }
    }
  });

  it("does NOT tell agents a vendor gap is never an engineering matter", () => {
    expect(line()).not.toMatch(/NEVER an engineering ticket/i);
  });

  it("x is stageable now (enabled 2026-09-08) and LinkedIn company pages stay declined", () => {
    expect(SOCIAL_CHANNEL_ACTIONS.x.enabled).toBe(true);
    expect(stageableChannelProse()).toMatch(/\bX\b/);
    expect(unavailableChannelProse()).toMatch(/LinkedIn company pages/);
  });

  it("still declines a channel that is switched off in the map", () => {
    const original = SOCIAL_CHANNEL_ACTIONS.x.enabled;
    try {
      (SOCIAL_CHANNEL_ACTIONS.x as { enabled: boolean }).enabled = false;
      expect(unavailableChannelProse()).toMatch(/\bX\b/);
      expect(stageableChannelProse()).not.toMatch(/(^|[\s,])X([\s,]|$)/);
    } finally {
      (SOCIAL_CHANNEL_ACTIONS.x as { enabled: boolean }).enabled = original;
    }
  });
});

describe("BUG 5 — REGRESSION NET: the map drives the words", () => {
  it("disabling a channel changes what every agent is told", () => {
    const before = line();
    const original = SOCIAL_CHANNEL_ACTIONS.x.enabled;
    try {
      (SOCIAL_CHANNEL_ACTIONS.x as { enabled: boolean }).enabled = false;
      expect(line()).not.toBe(before);
      expect(stageableChannelProse()).not.toMatch(/(^|[\s,])X([\s,]|$)/);
    } finally {
      (SOCIAL_CHANNEL_ACTIONS.x as { enabled: boolean }).enabled = original;
    }
  });

  it("clearing a vendor block drops that channel from the OUR-side clause", () => {
    const original = SOCIAL_CHANNEL_ACTIONS.instagram_image.vendor_review_pending;
    try {
      delete (SOCIAL_CHANNEL_ACTIONS.instagram_image as { vendor_review_pending?: string })
        .vendor_review_pending;
      expect(vendorBlockedChannelProse()).not.toMatch(/Instagram/);
      expect(stageableChannelProse()).toMatch(/Instagram/);
    } finally {
      (SOCIAL_CHANNEL_ACTIONS.instagram_image as { vendor_review_pending?: string })
        .vendor_review_pending = original;
    }
  });
});
