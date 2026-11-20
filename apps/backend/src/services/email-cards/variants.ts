
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { neutralizeTags, render, RENDERER_VERSION, type EmailContent, type EmailRoute, type EmailTemplate, type RenderContext } from "@/services/email-templates/render";

const CARD = z
  .object({
    title: z.string().min(1).max(120),
    meta: z.string().max(200),
    price: z.string().max(60).optional(),
    url: z.string().max(2048).optional(),
    image_url: z.string().max(2048).optional(),
  })
  .strict();

export const HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function oneLineField(label: string, min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !HEADER_CONTROL_CHARS.test(v), {
      message: `The ${label} must be on one line: remove the line break or hidden character from it.`,
    });
}

function contentSchema(oneLine: boolean) {
  return z
    .object({
      subject: oneLine ? oneLineField("subject", 1, 200) : z.string().min(1).max(200),
      preview_text: oneLine ? oneLineField("preview text", 0, 200) : z.string().max(200),
      title: z.string().min(1).max(200),
      hero: z.object({ big: z.string().min(1).max(80), small: z.string().max(200) }).strict().optional(),
      paragraphs: z.array(z.string().min(1).max(5_000)).min(1).max(20),
      button: z.object({ label: z.string().min(1).max(60), url: z.string().min(1).max(2048) }).strict(),
      cards: z.array(CARD).max(6).optional(),
    })
    .strict();
}

export const emailContentSchema = contentSchema(true);

const SHA = /^[0-9a-f]{64}$/;

export const sealedVariantSchema = z
  .object({
    content: contentSchema(false),
    html: z.string().min(1).max(500_000),
    text: z.string().min(1).max(200_000),
    render_sha: z.string().regex(SHA),
  })
  .strict();
export type SealedVariant = z.infer<typeof sealedVariantSchema>;

export const templateSnapshotSchema = z
  .object({
    logo_url: z.string().max(2048).nullable(),
    brand_color: z.string().max(7),
    button_color: z.string().max(7),
    font_key: z.string().max(40),
    sign_off: z.string().max(300),
    postal_address: z.string().max(500).nullable(),
    show_cards: z.boolean(),
    company_name: z.string().max(200).nullable(),
    own_host: z.string().max(253).nullable(),
    campaign_slug: z.string().max(80),
  })
  .strict();
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;

export const sealedVariantFields = {
  variants: z.array(sealedVariantSchema).min(1).max(3),
  template_snapshot: templateSnapshotSchema,
  renderer_version: z.string().min(1).max(40),
  chosen_variant: z.number().int().min(1).max(3).optional(),
  approved_count: z.number().int().min(0).optional(),
};

export function shaOf(rendererVersion: string, html: string, text: string): string {
  return createHash("sha256").update(rendererVersion).update("\0").update(html).update("\0").update(text).digest("hex");
}

export function newSlugSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
}

export function campaignSlugFor(subject: string, now: Date = new Date(), suffix: string | null = null): string {
  const words = subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const own = suffix && /^[a-z0-9]{10}$/.test(suffix) ? `-${suffix}` : "";
  return `${words || "email"}-${day}${own}`;
}

export function sealVariants(
  template: EmailTemplate,
  contents: readonly EmailContent[],
  ctx: { route: EmailRoute; companyName: string | null; ownHost: string | null; now?: Date; slugSuffix?: string },
): { variants: SealedVariant[]; template_snapshot: TemplateSnapshot; renderer_version: string } {
  const campaign_slug = campaignSlugFor(contents[0]?.subject ?? "", ctx.now, ctx.slugSuffix ?? newSlugSuffix());
  const rctx: RenderContext = { route: ctx.route, campaignSlug: campaign_slug, ownHost: ctx.ownHost, companyName: ctx.companyName };
  const variants = contents.map((content) => {
    const r = render(template, content, rctx);
    return { content: content as SealedVariant["content"], html: r.html, text: r.text, render_sha: r.render_sha };
  });
  return {
    variants,
    template_snapshot: {
      logo_url: template.logo_url,
      brand_color: template.brand_color,
      button_color: template.button_color,
      font_key: template.font_key,
      sign_off: template.sign_off,
      postal_address: template.postal_address,
      show_cards: template.show_cards,
      company_name: ctx.companyName,
      own_host: ctx.ownHost,
      campaign_slug,
    },
    renderer_version: RENDERER_VERSION,
  };
}

export type ChosenVersion = { n: number; subject: string; preview_text: string | null; html: string; text: string; render_sha: string };

export function chosenVersion(b: {
  variants: SealedVariant[];
  renderer_version: string;
  chosen_variant?: number;
}): { ok: true; version: ChosenVersion } | { ok: false; reason: string } {
  if (!b.chosen_variant) return { ok: false, reason: "No version of this email was picked when it was approved." };
  const v = b.variants[b.chosen_variant - 1];
  if (!v) return { ok: false, reason: `Version ${b.chosen_variant} of this email does not exist.` };
  if (shaOf(b.renderer_version, v.html, v.text) !== v.render_sha) {
    return { ok: false, reason: "The approved email does not match what was rendered for the card." };
  }
  const preview = neutralizeTags(v.content.preview_text.trim());
  return { ok: true, version: { n: b.chosen_variant, subject: neutralizeTags(v.content.subject), preview_text: preview || null, html: v.html, text: v.text, render_sha: v.render_sha } };
}

export const MAX_LIST_GROWTH = 0.1;
export const AUTOPILOT_SEND_CAP = 1_000;

export function countAtSendRefusal(a: { approved: number; live: number; byAutopilot: boolean; planned?: boolean }): string | null {
  if (a.byAutopilot && a.live > AUTOPILOT_SEND_CAP) {
    return `The list now has ${a.live.toLocaleString("en-US")} people, more than the ${AUTOPILOT_SEND_CAP.toLocaleString("en-US")} Autopilot may send to. Nothing was sent. Send it yourself if it is still right.`;
  }
  if (a.live > Math.floor(a.approved * (1 + MAX_LIST_GROWTH))) {
    if (a.byAutopilot && a.planned) {
      return `Autopilot did not send this planned email because the list grew from ${a.approved.toLocaleString("en-US")} to ${a.live.toLocaleString("en-US")} people since it was approved for this slot, more than 10%. Nothing was sent, and this planned send will not go out on its own. Send it yourself from the card if it should go to everyone on the list now.`;
    }
    return `The list grew from ${a.approved.toLocaleString("en-US")} to ${a.live.toLocaleString("en-US")} people since this was approved, more than 10%. Nothing was sent. Approve it again if it should go to everyone on the list now.`;
  }
  return null;
}

export const TEST_LISTS_FIELD = "email_test_lists";

export function testListKey(route: EmailRoute, listId: string): string {
  return `${route}:${route === "zavi_list" ? listId.trim().toLowerCase() : listId}`;
}

export async function readTestListKeys(tenantId: string): Promise<ReadonlySet<string>> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "get_channel_settings", { p_channel_slug: "email_marketing" });
  if (error) throw new Error("get_channel_settings failed");
  const items = ((data as { fields?: Record<string, unknown> } | null)?.fields ?? {})[TEST_LISTS_FIELD];
  const keys = new Set<string>();
  if (!Array.isArray(items)) return keys;
  for (const raw of items) {
    const row = raw as { item?: unknown; status?: unknown } | null;
    if (row?.status === "dismissed") continue;
    const item = typeof row?.item === "string" ? row.item.trim() : "";
    if (item) keys.add(item);
  }
  return keys;
}

export const TEST_LIST_REFUSAL = "This list is marked as a test list in Email campaigns settings, so Zavi never sends a real email to it. Nothing was sent.";

export function resealVariant(snapshot: TemplateSnapshot, route: EmailRoute, content: EmailContent, rendererVersion: string = RENDERER_VERSION): SealedVariant {
  const template: EmailTemplate = {
    logo_url: snapshot.logo_url,
    brand_color: snapshot.brand_color,
    button_color: snapshot.button_color,
    font_key: snapshot.font_key,
    sign_off: snapshot.sign_off,
    postal_address: snapshot.postal_address,
    show_cards: snapshot.show_cards,
  };
  const r = render(template, content, { route, campaignSlug: snapshot.campaign_slug, ownHost: snapshot.own_host, companyName: snapshot.company_name });
  return { content: content as SealedVariant["content"], html: r.html, text: r.text, render_sha: shaOf(rendererVersion, r.html, r.text) };
}
