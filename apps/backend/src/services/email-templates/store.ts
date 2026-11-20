
import { z } from "zod";
import { tenantClient, type TenantId } from "@/services/tenant-client";
import { checkEmailUrl, EmailRenderError, FONT_KEYS, isFontKey, isHexColor, type EmailTemplate } from "./render";

export type StoredEmailTemplate = EmailTemplate & { updated_by: string | null; updated_at: string };

const COLUMNS = "logo_url,brand_color,button_color,font_key,sign_off,postal_address,show_cards,updated_by,updated_at";

function httpsImage(v: string): boolean {
  try {
    checkEmailUrl(v, "logo", "image");
    return true;
  } catch (e) {
    if (e instanceof EmailRenderError) return false;
    throw e;
  }
}

export const emailTemplateSchema = z
  .object({
    logo_url: z
      .string()
      .trim()
      .max(2048, { message: "The logo address is too long." })
      .refine(httpsImage, { message: "The logo must be a web address that starts with https://." })
      .nullable(),
    brand_color: z.string().trim().refine(isHexColor, { message: "The brand color must be a color like #1a73e8." }).transform((v) => v.toLowerCase()),
    button_color: z.string().trim().refine(isHexColor, { message: "The button color must be a color like #1a73e8." }).transform((v) => v.toLowerCase()),
    font_key: z.string().refine(isFontKey, { message: `The font must be one of: ${FONT_KEYS.join(", ")}.` }),
    sign_off: z.string().max(300, { message: "The sign-off is too long (300 characters at most)." }),
    postal_address: z
      .string()
      .trim()
      .max(500, { message: "The postal address is too long (500 characters at most)." })
      .nullable()
      .refine((value) => value !== null && value.length > 0, { message: "Add the business postal address required in every marketing email." }),
    show_cards: z.boolean(),
  })
  .strict();

export type EmailTemplateInput = z.infer<typeof emailTemplateSchema>;

function toTemplate(row: Record<string, unknown>): StoredEmailTemplate {
  return {
    logo_url: typeof row.logo_url === "string" ? row.logo_url : null,
    brand_color: String(row.brand_color),
    button_color: String(row.button_color),
    font_key: String(row.font_key),
    sign_off: typeof row.sign_off === "string" ? row.sign_off : "",
    postal_address: typeof row.postal_address === "string" && row.postal_address.trim() ? row.postal_address : null,
    show_cards: row.show_cards === true,
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_at: String(row.updated_at),
  };
}

export async function getEmailTemplate(tenantId: TenantId): Promise<StoredEmailTemplate | null> {
  const { data, error } = await tenantClient(tenantId).from("email_templates").select(COLUMNS).maybeSingle();
  if (error) throw new Error("email_templates read failed");
  return data ? toTemplate(data as Record<string, unknown>) : null;
}

export async function saveEmailTemplate(tenantId: TenantId, userId: string | null, input: unknown): Promise<StoredEmailTemplate> {
  const t = emailTemplateSchema.parse(input);
  const row = {
    tenant_id: tenantId,
    logo_url: t.logo_url || null,
    brand_color: t.brand_color,
    button_color: t.button_color,
    font_key: t.font_key,
    sign_off: t.sign_off,
    postal_address: t.postal_address || null,
    show_cards: t.show_cards,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await tenantClient(tenantId)
    .from("email_templates")
    .upsert(row, { onConflict: "tenant_id" })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error("email_templates write failed");
  return toTemplate(data as Record<string, unknown>);
}
