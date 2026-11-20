import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  appSetting: { value: false } as { value: unknown } | null,
  blob: {} as Record<string, unknown>,
  globalReads: [] as string[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));
vi.mock("@/services/settings", async (orig) => ({ ...(await orig<typeof import("@/services/settings")>()), getBoolSettingStrictResolved: async () => true }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const table = (name: string) => {
    mocks.globalReads.push(name);
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => {
        if (name === "app_setting") return { data: mocks.appSetting, error: null };
        if (name === "system_config") return { data: { blob: mocks.blob }, error: null };
        throw new Error(`unexpected global read ${name}`);
      },
    };
    return b;
  };
  return { ...real, globalClient: () => ({ from: table }) };
});

import { emailCardHandlers } from "@/routes/email-cards";
import type { CardDeps } from "../cards";
import { shaOf } from "../variants";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "33333333-3333-4333-8333-333333333333";
const RENDERER = "email-r1";

function sealed(n: number) {
  const html = `<p>v${n}</p><a href="{{zavi_unsubscribe_url}}">Unsubscribe</a>`;
  const text = `v${n} Unsubscribe: {{zavi_unsubscribe_url}}`;
  return {
    content: { subject: `Subject ${n}`, preview_text: "", title: "t", paragraphs: ["p"], button: { label: "Go", url: "https://brightloop.test" } },
    html,
    text,
    render_sha: shaOf(RENDERER, html, text),
  };
}

const listBody = {
  list_id: "44444444-4444-4444-8444-444444444444",
  list_version_id: "55555555-5555-4555-8555-555555555555",
  list_name: "Brightloop testers",
  from_address: "hello@brightloop.test",
  reply_to: null,
  variants: [sealed(1), sealed(2)],
  template_snapshot: {
    logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 St",
    show_cards: false, company_name: null, own_host: null, campaign_slug: "s-20261011",
  },
  renderer_version: RENDERER,
};

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

function harness() {
  const calls: string[] = [];
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      calls.push(name);
      if (name === "email_card_for_test") return { ok: true, class: "bulk_outbound.send", body: listBody, test_sha: "c".repeat(64) };
      if (name === "record_email_test_send") return { ok: true };
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    confirmedEmail: async () => "owner@brightloop.test",
  };
  return { h: emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never), calls };
}

const providerCalls = vi.fn(async () => new Response(null, { status: 202 }));
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BULK_SENDGRID_API_KEY;
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  mocks.appSetting = { value: false };
  mocks.blob = {};
  mocks.globalReads.length = 0;
  providerCalls.mockClear();
  vi.stubGlobal("fetch", providerCalls);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.BULK_SENDGRID_API_KEY;
  else process.env.BULK_SENDGRID_API_KEY = savedKey;
});

describe("81fb: Send test on a Zavi-list card while Zavi's own sender is stopped", () => {
  it.each([
    ["the staff switch", () => void (mocks.appSetting = { value: false })],
    ["the old system_config switch", () => {
      mocks.appSetting = null;
      mocks.blob = { bulk_email_send_enabled: "false" };
    }],
  ])("through %s: the founder reads plain words that the sender is stopped, never the internal label, and nothing is sent or recorded", async (_label, stop) => {
    stop();
    const { h, calls } = harness();
    const r = res();
    await h.test({ params: { rail: "decisions", id: CARD }, body: { variant: 2 } } as never, r as never);

    expect(mocks.globalReads).toEqual(expect.arrayContaining(["app_setting", "system_config"]));
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("sender_not_ready");
    const message: string = r.body.error.message;
    expect(message).not.toMatch(/Zavi sender stopped/i);
    expect(message).not.toMatch(/^[^.]{0,40}:\s/);
    expect(message).toMatch(/^Zavi's own sender is stopped for every workspace right now/);
    expect(message).toContain("no email can go out");
    expect(providerCalls).not.toHaveBeenCalled();
    expect(calls).toEqual(["email_card_for_test"]);
  });
});
