import { beforeEach, describe, expect, it, vi } from "vitest";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => {
  const state: { fields: Record<string, Record<string, Array<Record<string, unknown>>>> } = { fields: {} };
  const tenantRpc = vi.fn(async (_t: string, fn: string, args: Record<string, unknown>) => {
    if (fn !== "get_channel_settings") return { data: null, error: null };
    return { data: { fields: state.fields[String(args.p_channel_slug)] ?? {} }, error: null };
  });
  return { state, tenantRpc };
});

vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: h.tenantRpc }));
vi.mock("@/services/email-templates/store", () => ({ getEmailTemplate: async () => null }));
vi.mock("@/services/channels/reddit/db", () => ({ redditDb: () => ({}) }));
vi.mock("../reddit/workspace", () => ({
  readRedditWorkspace: async () => ({ keywords: [], competitors: [], communities: [] }),
  workspaceRunContext: () => ({}),
}));

import { defaultChannelContext, projectSettings } from "@/services/channels/context";
import { buildChannelSettingsNote, withChannelSettingsNote } from "@/services/agents/channel-settings-note";
import { settingsFieldRole } from "@zavi/shared";

const settingsOf = (ctx: Record<string, unknown> | null) =>
  ((ctx ?? {}) as { channel_settings?: Record<string, unknown[]> }).channel_settings ?? {};

beforeEach(() => {
  h.state.fields = {
    email_marketing: {
      esp: [{ id: "e1", item: "klaviyo", status: "tracking", origin: "founder", note: "from mobile" }],
      segments: [{ id: "s1", item: "Members", item_type: "marketing_optin", status: "tracking" }],
    },
  };
});

describe("a stale esp saved from mobile", () => {
  it("never reaches the email run's context, its settings note, or the turn", async () => {
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx)).not.toHaveProperty("esp");
    expect(JSON.stringify(ctx)).not.toContain("klaviyo");
    const note = buildChannelSettingsNote("email_marketing", settingsOf(ctx));
    expect(note).toContain("Members");
    expect(note).not.toMatch(/klaviyo|esp/i);
    const turn = withChannelSettingsNote("Plan the next email.", "email_marketing", settingsOf(ctx));
    expect(turn).not.toMatch(/klaviyo/i);
  });

  it("is dropped even when it is the only email setting saved", async () => {
    h.state.fields.email_marketing = { esp: [{ id: "e1", item: "mailchimp" }] };
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx)).toEqual({});
    expect(buildChannelSettingsNote("email_marketing", settingsOf(ctx))).toBeNull();
  });

  it("is dropped by projection on email_marketing only", () => {
    const fields = { esp: [{ item: "omnisend" }] };
    expect(projectSettings(fields, "email_marketing")).toBeNull();
    expect(projectSettings(fields, "sms")).toEqual({ esp: [{ item: "omnisend" }] });
  });

  it("has no role left to describe it", () => {
    expect(settingsFieldRole("email_marketing", "esp")).toBeNull();
  });
});
