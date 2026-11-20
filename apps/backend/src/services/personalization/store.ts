
import { z } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isMissingRelation, noteMissingRelationOnce } from "./missing-relation";

export const BASE_TONES = ["default", "concise", "friendly", "professional", "direct"] as const;
export type BaseTone = (typeof BASE_TONES)[number];

export const CUSTOM_INSTRUCTIONS_MAX = 4000;
const SHORT_TEXT_MAX = 2000;

export type TenantPersonalization = {
  base_tone: BaseTone;
  warm: boolean;
  enthusiastic: boolean;
  headers_lists: boolean;
  emoji: boolean;
  custom_instructions: string;
  brand_voice: string;
  response_rules: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
};

export const DEFAULT_PERSONALIZATION: TenantPersonalization = {
  base_tone: "default",
  warm: false,
  enthusiastic: false,
  headers_lists: true,
  emoji: false,
  custom_instructions: "",
  brand_voice: "",
  response_rules: "",
  version: 0,
  updated_at: null,
  updated_by: null,
};

export const PersonalizationPatch = z
  .object({
    base_tone: z.enum(BASE_TONES).optional(),
    warm: z.boolean().optional(),
    enthusiastic: z.boolean().optional(),
    headers_lists: z.boolean().optional(),
    emoji: z.boolean().optional(),
    custom_instructions: z.string().max(CUSTOM_INSTRUCTIONS_MAX).optional(),
    brand_voice: z.string().max(SHORT_TEXT_MAX).optional(),
    response_rules: z.string().max(SHORT_TEXT_MAX).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "at least one field is required" });

export type PersonalizationPatchInput = z.infer<typeof PersonalizationPatch>;

const SELECT =
  "base_tone, warm, enthusiastic, headers_lists, emoji, custom_instructions, brand_voice, response_rules, version, updated_at, updated_by";

function coerceRow(raw: unknown): TenantPersonalization {
  const r = (raw ?? {}) as Record<string, unknown>;
  const tone = BASE_TONES.includes(r.base_tone as BaseTone)
    ? (r.base_tone as BaseTone)
    : DEFAULT_PERSONALIZATION.base_tone;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    base_tone: tone,
    warm: bool(r.warm, false),
    enthusiastic: bool(r.enthusiastic, false),
    headers_lists: bool(r.headers_lists, true),
    emoji: bool(r.emoji, false),
    custom_instructions: text(r.custom_instructions),
    brand_voice: text(r.brand_voice),
    response_rules: text(r.response_rules),
    version: typeof r.version === "number" && Number.isFinite(r.version) ? r.version : 0,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    updated_by: typeof r.updated_by === "string" ? r.updated_by : null,
  };
}

export async function getTenantPersonalization(tenant_id: string): Promise<TenantPersonalization> {
  if (!tenant_id) return DEFAULT_PERSONALIZATION;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_personalization")
      .select(SELECT)
      .maybeSingle();
    if (error) {
      if (isMissingRelation(error)) {
        noteMissingRelationOnce("tenant_personalization", error);
        return DEFAULT_PERSONALIZATION;
      }
      throw new Error(error.message);
    }
    return data ? coerceRow(data) : DEFAULT_PERSONALIZATION;
  } catch (e) {
    if (isMissingRelation(e)) {
      noteMissingRelationOnce("tenant_personalization", e);
      return DEFAULT_PERSONALIZATION;
    }
    throw e;
  }
}

export async function saveTenantPersonalization(
  tenant_id: string,
  patch: PersonalizationPatchInput,
  actor_user_id: string | null,
): Promise<TenantPersonalization> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "set_tenant_personalization", {
    p_patch: patch,
    p_actor: actor_user_id,
  });
  if (error) throw new Error(error.message);
  return coerceRow(data);
}
