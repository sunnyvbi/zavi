import { describe, it, expect, vi, beforeEach } from "vitest";

const lock = vi.hoisted(() => ({ locked: new Set<string>(), unreadable: false }));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: vi.fn(async (slug: string) => lock.locked.has(slug)),
  isChannelLockedStrict: vi.fn(async (slug: string) => {
    if (lock.unreadable) throw new Error("config unreadable");
    return lock.locked.has(slug);
  }),
}));
vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import { execPlatformLabel, platformWriteEnabled } from "../exec-kill-switch";
import { EMAIL_SEND_CLASS } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_TOOLS } from "@/services/connectors/email-campaign/providers";

beforeEach(() => {
  lock.locked.clear();
  lock.unreadable = false;
});

describe("email_marketing lock covers SendGrid sends", () => {
  it("SendGrid is one of the tools on the one email send class", () => {
    expect(EMAIL_TOOLS).toContain("sendgrid");
    expect(EMAIL_SEND_CLASS).toBe("email_campaign.create_and_send");
  });

  it("open by default, closed when the Email campaigns channel is locked, closed when unreadable", async () => {
    expect(await platformWriteEnabled(EMAIL_SEND_CLASS)).toBe(true);
    lock.locked.add("email_marketing");
    expect(await platformWriteEnabled(EMAIL_SEND_CLASS)).toBe(false);
    lock.locked.clear();
    lock.unreadable = true;
    expect(await platformWriteEnabled(EMAIL_SEND_CLASS)).toBe(false);
  });

  it("the note the founder reads names SendGrid", () => {
    expect(execPlatformLabel(EMAIL_SEND_CLASS)).toBe("Mailchimp, Klaviyo or SendGrid");
  });
});
