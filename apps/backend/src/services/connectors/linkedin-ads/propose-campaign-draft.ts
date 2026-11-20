import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { isLinkedInAdsWriteEnabled } from "@/services/tools/linkedin-ads/write/_flag-check";
import { linkedinCampaignDraftPresentationSchema, stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions, type RecordDeps } from "@/services/channels/channel-actions";
import { insertFounderRun } from "./propose-pause";

const CHANNEL = "linkedin_ads";
export const FOUNDER_DRAFT_RUN_STAGE = "linkedin_ads_founder_campaign_draft";
const FOUNDER_DRAFT_RATIONALE = "You started this campaign from the LinkedIn Ads channel page. Pick the company post to promote when you review it.";
const SEEDED_RATIONALE = "You started this campaign from the LinkedIn Ads channel page. Zavi filled in the audience, places and post from its latest LinkedIn plan; change any of them when you review it.";
const POST_PREVIEW = "Paste the link to the company post when you review this draft.";
const STEP_TITLE = "Review and create your LinkedIn campaign";
const REPLACED_DRAFT = "You started a new LinkedIn campaign, so Zavi closed this older draft you had not used.";

export const founderCampaignDraftInput = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/)
    .optional(),
});

const RECORD_DEPS: RecordDeps = {
  loadMatchPool: async () => [],
  matchCards: async () => null,
  displace: async () => 0,
};

type Presentation = z.infer<typeof linkedinCampaignDraftPresentationSchema>;
export type FounderDraftSeed = Pick<Presentation, "post_urn" | "post_preview" | "country" | "locations" | "excluded_locations" | "language" | "audience_suggestions">;

const SEED_KEYS = ["post_urn", "post_preview", "country", "locations", "excluded_locations", "language", "audience_suggestions"] as const;

export function founderDraftSeed(presentation: unknown): FounderDraftSeed | null {
  const parsed = linkedinCampaignDraftPresentationSchema.safeParse(presentation);
  if (!parsed.success) return null;
  const seed: Partial<FounderDraftSeed> = {};
  for (const key of SEED_KEYS) {
    const value = parsed.data[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (key === "post_preview" && !parsed.data.post_urn) continue;
    (seed as Record<string, unknown>)[key] = value;
  }
  const facets = parsed.data.audience_suggestions ? Object.values(parsed.data.audience_suggestions).some((v) => Array.isArray(v) && v.length > 0) : false;
  if (!facets) delete seed.audience_suggestions;
  const meaningful = !!seed.post_urn || !!seed.locations || !!seed.excluded_locations || !!seed.audience_suggestions;
  return meaningful ? (seed as FounderDraftSeed) : null;
}

export function founderCampaignDraftStep(name: string, day: string, seed: FounderDraftSeed | null = null) {
  const rationale = seed ? SEEDED_RATIONALE : FOUNDER_DRAFT_RATIONALE;
  const presentation = linkedinCampaignDraftPresentationSchema.parse({
    type: "campaign_draft",
    channel: CHANNEL,
    name,
    group_name: `LinkedIn audience - ${day}`,
    rationale,
    post_preview: POST_PREVIEW,
    country: "US",
    language: "en",
    ...(seed ?? {}),
  });
  return {
    title: STEP_TITLE,
    body: `Set the daily budget, bid, country and the company post for "${name}". Zavi creates it paused in LinkedIn Campaign Manager, and nothing spends until you launch it.`,
    blocking: false,
    effort: "minutes",
    evidence: [rationale],
    responsibility: "client",
    action_type: "create_ad",
    intent: "create",
    deliverable: {
      kind: "ad",
      label: "LinkedIn campaign draft",
      content: `${presentation.name}\n${presentation.group_name}\n${presentation.post_preview}`,
      presentation,
    },
  };
}

type OpenRow = {
  id: string;
  run_id: string | null;
  status: string;
  exec_class: string | null;
  exec_status: string | null;
  edited_body: unknown;
  steps_done: unknown;
  body: { step?: { responsibility?: unknown; deliverable?: { presentation?: { type?: unknown; channel?: unknown; name?: unknown } } } } | null;
};

async function waitingFounderDrafts(tenant_id: string): Promise<Array<{ id: string; name: unknown }>> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("channel_actions")
    .select("id,run_id,status,exec_class,exec_status,edited_body,steps_done,body")
    .eq("channel_slug", CHANNEL)
    .eq("status", "pending")
    .is("exec_class", null)
    .order("proposed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`linkedin founder draft: open cards unreadable: ${error.message}`);
  const untouched = ((data ?? []) as OpenRow[]).filter(
    (r) =>
      r.status === "pending" &&
      r.exec_class == null &&
      r.exec_status == null &&
      r.edited_body == null &&
      (r.steps_done == null || (Array.isArray(r.steps_done) && r.steps_done.length === 0)) &&
      typeof r.run_id === "string" &&
      r.body?.step?.responsibility === "client" &&
      r.body.step.deliverable?.presentation?.type === "campaign_draft" &&
      r.body.step.deliverable.presentation.channel === CHANNEL,
  );
  if (untouched.length === 0) return [];
  const runIds = [...new Set(untouched.map((r) => r.run_id as string))];
  const runs = await db.from("agent_runs").select("id").in("id", runIds).eq("agent_definition_hash", FOUNDER_DRAFT_RUN_STAGE);
  if (runs.error) throw new Error(`linkedin founder draft: runs unreadable: ${runs.error.message}`);
  const founderRuns = new Set(((runs.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  return untouched.filter((r) => founderRuns.has(r.run_id as string)).map((r) => ({ id: r.id, name: r.body?.step?.deliverable?.presentation?.name }));
}

async function latestModelDraft(tenant_id: string): Promise<FounderDraftSeed | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("channel_actions")
    .select("id,run_id,body")
    .eq("channel_slug", CHANNEL)
    .order("proposed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`linkedin founder draft: earlier drafts unreadable: ${error.message}`);
  const drafts = ((data ?? []) as OpenRow[]).filter(
    (r) => typeof r.run_id === "string" && r.body?.step?.deliverable?.presentation?.type === "campaign_draft" && r.body.step.deliverable.presentation.channel === CHANNEL,
  );
  if (drafts.length === 0) return null;
  const runs = await db.from("agent_runs").select("id").in("id", [...new Set(drafts.map((r) => r.run_id as string))]).eq("agent_definition_hash", FOUNDER_DRAFT_RUN_STAGE);
  if (runs.error) throw new Error(`linkedin founder draft: runs unreadable: ${runs.error.message}`);
  const founderRuns = new Set(((runs.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const row of drafts) {
    if (founderRuns.has(row.run_id as string)) continue;
    const seed = founderDraftSeed(row.body?.step?.deliverable?.presentation);
    if (seed) return seed;
  }
  return null;
}

export async function fileFounderCampaignDraft(
  tenant_id: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<{ action_id: string; reused: boolean }> {
  const input = founderCampaignDraftInput.parse(rawInput ?? {});
  if (!(await isLinkedInAdsWriteEnabled())) {
    throw new ExpectedToolError("linkedin_ads_writes_off", "LinkedIn Ads changes are switched off on this server, so Zavi cannot create campaigns yet.");
  }
  const { goalToday } = await import("@/services/growth/goal-owner");
  const day = await goalToday(tenant_id, now);
  const name = input.name ?? `LinkedIn campaign - ${day}`;
  const waiting = await waitingFounderDrafts(tenant_id);
  const same = waiting.find((w) => w.name === name);
  if (same) return { action_id: same.id, reused: true };
  const seed = await latestModelDraft(tenant_id).catch(() => null);
  const step = founderCampaignDraftStep(name, day, seed);
  const envelope = { rendered_markdown: step.body, steps: [step], ...(waiting.length ? { stale: waiting.map((w) => ({ action_id: w.id, evidence: REPLACED_DRAFT })) } : {}) };
  const bodies = stepDecisionBodies(envelope);
  if (bodies.length !== 1) throw new Error("linkedin founder draft: the draft step did not parse");
  const run_id = await insertFounderRun(tenant_id, now, FOUNDER_DRAFT_RUN_STAGE, "The founder started a LinkedIn campaign draft (no model run).");
  const recorded = await recordChannelRunActions({ tenantId: tenant_id, runId: run_id, channelSlug: CHANNEL, envelope, bodies, redo: null }, RECORD_DEPS);
  const id = recorded.ids[0]?.id ?? recorded.kept[0]?.id;
  if (!id) throw new Error("linkedin founder draft: no card was filed");
  return { action_id: id, reused: false };
}
