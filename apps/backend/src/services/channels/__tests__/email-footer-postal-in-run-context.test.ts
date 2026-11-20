import { beforeEach, describe, expect, it, vi } from "vitest";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";
const FOOTER = "123 Test Street, San Francisco, CA 94105, USA";
const STALE = "Yoga Studio, 123 Test Street, Suite 4, San Francisco, CA 94105";

const h = vi.hoisted(() => {
  const state: {
    fields: Record<string, Record<string, Array<Record<string, unknown>>>>;
    settingsError: boolean;
    template: { postal_address: string | null } | null;
    templateThrows: boolean;
  } = { fields: {}, settingsError: false, template: null, templateThrows: false };
  const tenantRpc = vi.fn(async (_t: string, fn: string, args: Record<string, unknown>) => {
    if (fn !== "get_channel_settings") return { data: null, error: null };
    if (state.settingsError) return { data: null, error: { message: "boom" } };
    return { data: { fields: state.fields[String(args.p_channel_slug)] ?? {} }, error: null };
  });
  const getEmailTemplate = vi.fn(async () => {
    if (state.templateThrows) throw new Error("email_templates read failed");
    return state.template;
  });
  return { state, tenantRpc, getEmailTemplate };
});

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: h.tenantRpc,
}));
vi.mock("@/services/email-templates/store", () => ({ getEmailTemplate: h.getEmailTemplate }));
vi.mock("@/services/channels/reddit/db", () => ({ redditDb: () => ({}) }));
vi.mock("../reddit/workspace", () => ({
  readRedditWorkspace: async () => ({ keywords: [], competitors: [], communities: [] }),
  workspaceRunContext: () => ({}),
}));

import { defaultChannelContext } from "@/services/channels/context";
import { buildChannelSettingsNote, withChannelSettingsNote } from "@/services/agents/channel-settings-note";

function settingsOf(ctx: Record<string, unknown> | null): Record<string, unknown[]> {
  return ((ctx ?? {}) as { channel_settings?: Record<string, unknown[]> }).channel_settings ?? {};
}

beforeEach(() => {
  h.state.fields = {
    email_marketing: {
      postal_address: [{ id: "pa-1", item: STALE, status: "tracking", origin: "zavi" }],
      segments: [{ id: "sg-1", item: "Members", item_type: "marketing_optin", status: "tracking" }],
    },
    google_ads: {
      postal_address: [{ id: "pa-2", item: STALE, status: "tracking" }],
    },
  };
  h.state.settingsError = false;
  h.state.template = { postal_address: FOOTER };
  h.state.templateThrows = false;
  h.getEmailTemplate.mockClear();
});

describe("the email run reads the postal address from Settings > Footer", () => {
  it("the footer wins over a contradicting channel setting, in the context and in the note the run reads last", async () => {
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx).postal_address).toEqual([{ item: FOOTER }]);
    expect(JSON.stringify(ctx)).not.toContain("Yoga Studio");
    const note = buildChannelSettingsNote("email_marketing", settingsOf(ctx));
    expect(note).toContain(JSON.stringify(FOOTER));
    expect(note).not.toContain("Yoga Studio");
    const turn = withChannelSettingsNote("Run the email plan.", "email_marketing", settingsOf(ctx));
    expect(turn).not.toContain("Yoga Studio");
    expect(turn.endsWith(note!)).toBe(true);
  });

  it("keeps every other email setting the founder saved", async () => {
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx).segments).toEqual([{ item: "Members", item_type: "marketing_optin", status: "tracking" }]);
  });

  it("an address only in the old channel setting never reaches the run when a saved footer has none", async () => {
    for (const t of [{ postal_address: "   " }, { postal_address: null }, { postal_address: "" }]) {
      h.state.template = t;
      const ctx = await defaultChannelContext(TID, "email_marketing");
      expect(settingsOf(ctx).postal_address).toBeUndefined();
      expect(settingsOf(ctx).segments).toEqual([{ item: "Members", item_type: "marketing_optin", status: "tracking" }]);
      expect(JSON.stringify(ctx)).not.toContain("Yoga Studio");
      expect(withChannelSettingsNote("Run the email plan.", "email_marketing", settingsOf(ctx))).not.toContain("Yoga Studio");
    }
  });

  it("a footer read failure drops the old setting and does not fail the run", async () => {
    h.state.templateThrows = true;
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx).postal_address).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain("Yoga Studio");
  });

  it("with no footer saved at all, the first active old setting is the run's postal address, trimmed and capped", async () => {
    h.state.template = null;
    h.state.fields.email_marketing.postal_address = [
      { id: "pa-0", item: "Dismissed Rd", status: "dismissed" },
      { id: "pa-1", item: "   ", status: "tracking" },
      { id: "pa-2", item: `  ${STALE}  `, status: "tracking" },
      { id: "pa-3", item: "Later Rd", status: "tracking" },
    ];
    let ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx).postal_address).toEqual([{ item: STALE }]);
    expect(settingsOf(ctx).segments).toEqual([{ item: "Members", item_type: "marketing_optin", status: "tracking" }]);
    expect(buildChannelSettingsNote("email_marketing", settingsOf(ctx))).toContain(JSON.stringify(STALE));
    expect(JSON.stringify(ctx)).not.toContain("Dismissed Rd");
    expect(JSON.stringify(ctx)).not.toContain("Later Rd");
    h.state.fields.email_marketing.postal_address = [{ id: "pa-4", item: "x".repeat(600), status: "tracking" }];
    ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx).postal_address).toEqual([{ item: "x".repeat(500) }]);
  });

  it("an email run whose only saved setting was the old address gets empty channel settings when the saved footer is empty", async () => {
    h.state.fields = { email_marketing: { postal_address: [{ id: "pa-1", item: STALE, status: "tracking" }] } };
    h.state.template = { postal_address: "" };
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx)).toEqual({});
    expect(JSON.stringify(ctx)).not.toContain("Yoga Studio");
  });

  it("the footer still reaches the run when the settings read fails", async () => {
    h.state.settingsError = true;
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx)).toEqual({ postal_address: [{ item: FOOTER }] });
  });

  it("the footer reaches the run when no channel setting was ever saved", async () => {
    h.state.fields = {};
    const ctx = await defaultChannelContext(TID, "email_marketing");
    expect(settingsOf(ctx)).toEqual({ postal_address: [{ item: FOOTER }] });
  });

  it("a dismissed stale setting is not revived when the footer is empty", async () => {
    h.state.fields.email_marketing.postal_address = [{ id: "pa-1", item: STALE, status: "dismissed" }];
    h.state.template = null;
    expect(settingsOf(await defaultChannelContext(TID, "email_marketing")).postal_address).toBeUndefined();
  });

  it("other channels never read the email footer", async () => {
    const ctx = await defaultChannelContext(TID, "google_ads");
    expect(h.getEmailTemplate).not.toHaveBeenCalled();
    expect(settingsOf(ctx).postal_address).toEqual([{ item: STALE, status: "tracking" }]);
  });
});
