import { createHash } from "node:crypto";
import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

const id = z.string().regex(/^\d{1,20}$/).nullable();
const progressSchema = z.object({
  version: z.literal(1),
  payload_hash: z.string(),
  account_binding_id: z.string().nullable(),
  group_id: id,
  campaign_id: id,
  creative_id: id,
  in_flight: z.enum(["group_id", "campaign_id", "creative_id"]).nullable(),
  group_paused: z.boolean(),
  archived: z.literal(true).optional(),
}).strict().refine(p => (!p.campaign_id || !!p.group_id) && (!p.creative_id || !!p.campaign_id) && (!p.group_paused || !!p.group_id) && (!p.archived || !!p.campaign_id));
export type LinkedInCreationProgress = z.infer<typeof progressSchema>;
export function inFlightResolvable(state: LinkedInCreationProgress): boolean {
  return (state.in_flight === "campaign_id" && !!state.group_id) || (state.in_flight === "creative_id" && !!state.campaign_id);
}

export function linkedinCreateResumable(raw: unknown): { resumable: boolean; made: boolean } {
  if (raw == null) return { resumable: true, made: false };
  const parsed = progressSchema.safeParse(raw);
  if (!parsed.success) return { resumable: false, made: true };
  const state = parsed.data;
  return { resumable: state.in_flight === null || inFlightResolvable(state), made: !!state.group_id || state.in_flight !== null };
}

export type LinkedInCreationJournal = {
  readonly state: LinkedInCreationProgress;
  readonly retryable: boolean;
  save(next: LinkedInCreationProgress): Promise<void>;
};

export function creationJournal(tenantId: string, actionId: string, claimId: string, payload: unknown, raw: unknown): LinkedInCreationJournal {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  let previous = raw ?? null;
  const initial = raw == null
    ? progressSchema.parse({ version: 1, payload_hash: hash, account_binding_id: null, group_id: null, campaign_id: null, creative_id: null, in_flight: null, group_paused: false })
    : progressSchema.safeParse(raw).success ? progressSchema.parse(raw) : null;
  if (!initial)
    throw new ExpectedToolError("exec_partial", "The saved creation progress could not be read. Nothing was retried.");
  let state: LinkedInCreationProgress = initial;
  if (state.payload_hash !== hash)
    throw new ExpectedToolError("exec_partial", "The saved campaign setup does not match this approval. Nothing was retried.");
  let confirmed = raw != null;
  return {
    get state() { return state; },
    get retryable() { return confirmed && state.in_flight === null; },
    async save(next) {
      confirmed = false;
      const parsed = progressSchema.parse(next);
      let query = tenantClient(asTenantId(tenantId)).from("channel_actions")
        .update({ exec_progress: parsed })
        .eq("id", actionId).eq("channel_slug", "linkedin_ads")
        .eq("exec_class", "linkedin_ads.create_campaign_bundle")
        .eq("exec_status", "dispatching").eq("exec_claim_id", claimId);
      query = previous === null ? query.is("exec_progress", null) : query.eq("exec_progress", JSON.stringify(previous));
      const { data, error } = await query.select("id");
      if (error || data?.length !== 1)
        throw new ExpectedToolError("exec_partial", "Campaign progress could not be confirmed. Nothing was retried; review the existing setup before continuing.");
      previous = parsed;
      state = parsed;
      confirmed = true;
    },
  };
}
