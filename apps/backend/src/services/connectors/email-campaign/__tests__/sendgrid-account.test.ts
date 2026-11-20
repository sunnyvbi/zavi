import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scopes: undefined as unknown, readError: null as string | null, secret: null as string | null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (state.readError ? { data: null, error: { message: state.readError } } : { data: state.scopes === undefined ? null : { scopes: state.scopes }, error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => state.secret }));
vi.mock("../credential", () => ({ sendgridKeyDigest: (k: string) => `digest:${k}` }));

import { resolveSendgridAccount, sendgridKeyNeedsPermissions } from "../sendgrid-account";

const ALL = ["mail_send", "marketing_lists_read", "single_sends_write", "stats_read", "senders_read", "suppression_groups_read"];

beforeEach(() => {
  state.scopes = undefined;
  state.readError = null;
  state.secret = "SG.brightloop.key";
});

describe("a SendGrid key saved with Mail Send only", () => {
  it("needs permissions and is not a campaign connection", async () => {
    state.scopes = ["mail_send"];
    expect(await sendgridKeyNeedsPermissions("t")).toBe(true);
    expect(await resolveSendgridAccount("t")).toBeNull();
  });

  it("a campaign-ready key does not need permissions and resolves as before", async () => {
    state.scopes = ALL;
    expect(await sendgridKeyNeedsPermissions("t")).toBe(false);
    expect(await resolveSendgridAccount("t")).toMatchObject({ api_key: "SG.brightloop.key" });
  });

  it("nothing saved, or scopes without a key, is not connected rather than needing permissions", async () => {
    expect(await sendgridKeyNeedsPermissions("t")).toBe(false);
    state.scopes = ["mail_send"];
    state.secret = null;
    expect(await sendgridKeyNeedsPermissions("t")).toBe(false);
  });

  it("a failed read throws instead of answering", async () => {
    state.readError = "down";
    await expect(sendgridKeyNeedsPermissions("t")).rejects.toThrow(/read failed/);
  });
});
