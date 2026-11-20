import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editEmailCardVersion, type CardDeps } from "../cards";
import { sealVariants } from "../variants";
import { RENDERER_VERSION, type EmailContent, type EmailTemplate } from "@/services/email-templates/render";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";

const TEMPLATE: EmailTemplate = { logo_url: null, brand_color: "#1a73e8", button_color: "#1a73e8", font_key: "system", sign_off: "", postal_address: "1 Main St", show_cards: false };
const content = (title: string): EmailContent => ({ subject: "Spring", preview_text: "", title, paragraphs: ["Hello."], button: { label: "Go", url: "https://brightloop.test" } });

const sqlSha = (rv: string, html: string, text: string) =>
  createHash("sha256").update(Buffer.concat([Buffer.from(rv, "utf8"), Buffer.from([0]), Buffer.from(html, "utf8"), Buffer.from([0]), Buffer.from(text, "utf8")])).digest("hex");

function cardSealedBy(oldVersion: string) {
  const s = sealVariants(TEMPLATE, [content("Old title")], { route: "sendgrid", companyName: null, ownHost: null, slugSuffix: "abcdefghij" });
  const variants = s.variants.map((v) => ({ ...v, render_sha: sqlSha(oldVersion, v.html, v.text) }));
  return { tool: "sendgrid", variants, template_snapshot: s.template_snapshot, renderer_version: oldVersion };
}

describe("editing a card sealed before a renderer version bump", () => {
  it("the edit is sealed under the card's own renderer version, so the SQL hash check accepts it", async () => {
    const old = "email-r0";
    expect(old).not.toBe(RENDERER_VERSION);
    const body = cardSealedBy(old);
    const writes: Array<Record<string, unknown>> = [];
    const rpc = (async (_t: string, name: string, args: Record<string, unknown>) => {
      if (name === "email_card_view_state") return { ok: true, class: "email_campaign.create_and_send", body, open: true, status: "pending", role: "member", versions: 1, tests: [] };
      if (name === "edit_email_card_variant") {
        writes.push(args);
        const sealed = args.p_sealed as { html: string; text: string; render_sha: string };
        const rv = (args.p_expected_body as { renderer_version: string }).renderer_version;
        return sqlSha(rv, sealed.html, sealed.text) === sealed.render_sha ? { ok: true } : { ok: false, code: "bad_variant" };
      }
      throw new Error(`unexpected ${name}`);
    }) as CardDeps["rpc"];
    const out = await editEmailCardVersion(T, "channel_actions", CARD, 1, "u-member", content("New title"), { rpc });
    expect(out).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    const sealed = writes[0].p_sealed as { html: string; text: string; render_sha: string };
    expect(sealed.html).toContain("New title");
    expect(sealed.render_sha).toBe(sqlSha(old, sealed.html, sealed.text));
  });

  it("a card on the current renderer version still edits", async () => {
    const body = cardSealedBy(RENDERER_VERSION);
    let wrote = 0;
    const rpc = (async (_t: string, name: string, args: Record<string, unknown>) => {
      if (name === "email_card_view_state") return { ok: true, class: "email_campaign.create_and_send", body, open: true, status: "pending", role: "owner", versions: 1, tests: [] };
      wrote += 1;
      const sealed = args.p_sealed as { html: string; text: string; render_sha: string };
      return sqlSha(RENDERER_VERSION, sealed.html, sealed.text) === sealed.render_sha ? { ok: true } : { ok: false, code: "bad_variant" };
    }) as CardDeps["rpc"];
    expect(await editEmailCardVersion(T, "channel_actions", CARD, 1, "u-owner", content("Newer"), { rpc })).toEqual({ ok: true });
    expect(wrote).toBe(1);
  });
});
