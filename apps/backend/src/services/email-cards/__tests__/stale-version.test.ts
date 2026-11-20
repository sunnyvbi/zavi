import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import { cardView, EMAIL_CARD_MESSAGES, type CardDeps, type ViewState } from "../cards";
import { sealVariants } from "../variants";
import { RENDERER_VERSION, type EmailContent, type EmailTemplate } from "@/services/email-templates/render";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const TEMPLATE: EmailTemplate = { logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 Main St", show_cards: false };
const content = (title: string): EmailContent => ({ subject: "Spring", preview_text: "", title, paragraphs: ["Hello."], button: { label: "Go", url: "https://brightloop.test" } });

function store() {
  const s = sealVariants(TEMPLATE, [content("Original A"), content("Original B")], { route: "sendgrid", companyName: null, ownHost: null, slugSuffix: "abcdefghij" });
  const db = { body: { tool: "sendgrid", audience_id: "L1", variants: s.variants, template_snapshot: s.template_snapshot, renderer_version: RENDERER_VERSION } as Record<string, unknown> };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const state = (): ViewState => ({
    ok: true, class: "email_campaign.create_and_send", body: JSON.parse(JSON.stringify(db.body)), open: true, status: "pending", role: "owner", versions: 2,
    tests: [{ variant: 1, tested_by_me: true, tested_by_approver: true }, { variant: 2, tested_by_me: true, tested_by_approver: true }],
  });
  const rpc = (async (_t: string, name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "email_card_view_state") return state();
    if (name === "edit_email_card_variant") {
      if (JSON.stringify(args.p_expected_body) !== JSON.stringify(db.body)) return { ok: false, code: "card_changed" };
      const variants = [...(db.body.variants as unknown[])];
      variants[(args.p_variant as number) - 1] = args.p_sealed;
      db.body = { ...db.body, variants };
      return { ok: true };
    }
    if (name === "approve_email_card" || name === "approve_email_card_seen") return { ok: true, replayed: false, attempt: 1 };
    throw new Error(`unexpected rpc ${name}`);
  }) as CardDeps["rpc"];
  const deps: Partial<CardDeps> = {
    rpc,
    liveCount: async () => 200,
    enqueue: async (e) => {
      enqueued.push(e);
    },
    paused: async () => false,
  };
  return { db, calls, enqueued, state, h: emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never) };
}

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

const req = (body: unknown, n?: string) => ({ params: { rail: "channel_actions", id: CARD, ...(n ? { n } : {}) }, body }) as never;
const titleOf = (body: Record<string, unknown>, i: number) => ((body.variants as Array<{ content: EmailContent }>)[i]).content.title;

describe("a founder acting on a version someone else changed after the card loaded", () => {
  it("a stale editor's save is refused with a reload message and the newer text is kept", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-a" });
    const s = store();
    const seenByA = cardView("channel_actions", CARD, s.state()).versions[0].seen;

    const b = res();
    await s.h.editVariant(req({ content: content("Edited by B"), seen: cardView("channel_actions", CARD, s.state()).versions[0].seen }, "1"), b as never);
    expect(b.statusCode).toBe(200);
    expect(titleOf(s.db.body, 0)).toBe("Edited by B");

    const a = res();
    await s.h.editVariant(req({ content: content("Edited by A"), seen: seenByA }, "1"), a as never);
    expect(a.statusCode).toBe(409);
    expect(a.body).toEqual({ error: { code: "version_changed", message: EMAIL_CARD_MESSAGES.version_changed } });
    expect(titleOf(s.db.body, 0)).toBe("Edited by B");
  });

  it("an edit of one version still saves when only another version changed", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-a" });
    const s = store();
    const seenB = cardView("channel_actions", CARD, s.state()).versions[1].seen;
    const first = res();
    await s.h.editVariant(req({ content: content("A changed"), seen: cardView("channel_actions", CARD, s.state()).versions[0].seen }, "1"), first as never);
    const second = res();
    await s.h.editVariant(req({ content: content("B changed"), seen: seenB }, "2"), second as never);
    expect(second.statusCode).toBe(200);
    expect([titleOf(s.db.body, 0), titleOf(s.db.body, 1)]).toEqual(["A changed", "B changed"]);
  });

  it("approve of a version that changed after the approver loaded it sends nothing", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-a" });
    const s = store();
    const seenByA = cardView("channel_actions", CARD, s.state()).versions[0].seen;
    const b = res();
    await s.h.editVariant(req({ content: content("Edited by B") }, "1"), b as never);
    expect(b.statusCode).toBe(200);

    const a = res();
    await s.h.approve(req({ variant: 1, request_id: "req-12345678", seen: seenByA }), a as never);
    expect(a.statusCode).toBe(409);
    expect(a.body.error.code).toBe("version_changed");
    expect(s.calls.some((c) => c.name === "approve_email_card" || c.name === "approve_email_card_seen")).toBe(false);
    expect(s.enqueued).toEqual([]);
  });

  it("approve of the version the approver read goes through the locked check with that exact version", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-a" });
    const s = store();
    const seen = cardView("channel_actions", CARD, s.state()).versions[0].seen;
    const a = res();
    await s.h.approve(req({ variant: 1, request_id: "req-12345678", seen }), a as never);
    expect(a.statusCode).toBe(200);
    const call = s.calls.find((c) => c.name === "approve_email_card_seen")!;
    expect(call.args.p_expected_variant).toEqual((s.db.body.variants as unknown[])[0]);
    expect(s.calls.some((c) => c.name === "approve_email_card")).toBe(false);
    expect(s.enqueued).toHaveLength(1);
  });
});
