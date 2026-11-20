import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { sendgridReadHandlers } from "../sendgrid";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}
const req = {} as never;
mocks.requireAuth.mockResolvedValue({ tenant_id: "t-brightloop", user_id: "u-1" });

function handlers(status?: number, connected = true) {
  const sg = fakeSendgrid();
  const fetch = (status ? async () => new Response("{}", { status }) : sg.fetch) as typeof globalThis.fetch;
  const h = sendgridReadHandlers({ resolve: async () => (connected ? { api_key: BRIGHTLOOP_KEY, key_digest: "d" } : null), fetch });
  return { h, sg };
}

describe("SendGrid settings reads", () => {
  it("senders, unsubscribe groups and lists, each pared to the fields the settings show", async () => {
    const { h } = handlers();
    const s = res();
    await h.senders(req, s as never);
    expect(s.body).toEqual({ senders: [{ id: "41", from_email: "hello@brightloop.test", from_name: "Brightloop", verified: true }] });
    const g = res();
    await h.suppressionGroups(req, g as never);
    expect(g.body.groups).toEqual([
      { id: "7", name: "Product news", is_default: true },
      { id: "8", name: "Billing", is_default: false },
    ]);
    const l = res();
    await h.lists(req, l as never);
    expect(l.body).toEqual({ lists: [{ id: "6a1f0c2e-0000-4000-8000-00000000b001", name: "Brightloop members", people: 238 }] });
  });

  it("not connected for campaigns, a rejected key and a rate limit each answer with a sentence", async () => {
    for (const [status, connected, code, http] of [
      [undefined, false, "sendgrid_not_connected", 409],
      [401, true, "sendgrid_key_rejected", 409],
      [429, true, "sendgrid_rate_limited", 429],
      [500, true, "sendgrid_unreachable", 502],
    ] as const) {
      const r = res();
      await handlers(status, connected).h.lists(req, r as never);
      expect([r.statusCode, r.body.error.code]).toEqual([http, code]);
      expect(r.body.error.message).toMatch(/\.$/);
      expect(JSON.stringify(r.body)).not.toContain(BRIGHTLOOP_KEY);
    }
  });
});
