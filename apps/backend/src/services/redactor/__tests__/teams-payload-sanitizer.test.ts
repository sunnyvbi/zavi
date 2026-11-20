import { describe, it, expect } from "vitest";
import { sanitizeTeamsActivityPayload } from "../teams-payload-sanitizer";

describe("sanitizeTeamsActivityPayload", () => {
  const activity = {
    type: "message",
    id: "1700000000000",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    channelId: "msteams",
    text: "email me at jane.doe@acme.com about the refund",
    from: { id: "29:abc", name: "Jane Doe", aadObjectId: "guid-1" },
    conversation: { id: "19:meeting_xyz@thread.v2", tenantId: "m365-tenant-1" },
    channelData: { tenant: { id: "m365-tenant-1" } },
    entities: [{ type: "mention", text: "<at>Zavi</at>" }],
  };

  it("redacts user content (email in text) while leaving structural ids intact", () => {
    const out = sanitizeTeamsActivityPayload(activity) as any;
    expect(out.id).toBe(activity.id);
    expect(out.serviceUrl).toBe(activity.serviceUrl);
    expect(out.channelId).toBe("msteams");
    expect(out.conversation.id).toBe(activity.conversation.id);
    expect(out.channelData.tenant.id).toBe("m365-tenant-1");
    expect(String(out.text)).not.toContain("jane.doe@acme.com");
  });

  it("is idempotent (re-sanitizing produces equal output)", () => {
    const once = sanitizeTeamsActivityPayload(activity);
    const twice = sanitizeTeamsActivityPayload(once);
    expect(twice).toEqual(once);
  });

  it("does not mutate the input object", () => {
    const snapshot = JSON.stringify(activity);
    sanitizeTeamsActivityPayload(activity);
    expect(JSON.stringify(activity)).toBe(snapshot);
  });

  it("handles arrays + nested objects without throwing", () => {
    const nested = { attachments: [{ content: { text: "ssn 123-45-6789" } }] };
    expect(() => sanitizeTeamsActivityPayload(nested)).not.toThrow();
  });
});
