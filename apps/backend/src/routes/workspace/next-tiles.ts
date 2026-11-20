
import type { Request, Response } from "express";
import { z } from "zod";
import {
  CHANNELS,
  DEFAULT_NEXT_TILES,
  isFirstRunDone,
  NEXT_TILE_MAKE_PROMPTS,
  NEXT_TILE_THINK_PROMPTS,
  resolveNextTiles,
  type NextTilesInput,
} from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import {
  readPlan,
  readPlanChannelSlugs,
  type GrowthPlanSection,
} from "./growth-plan";
import { isGrowthDraftInFlight } from "./growth-strategy-draft";
import { isRecordOnlyRun } from "@/services/channels/record-only-run";
import { annotateLockedTier } from "@/services/agents/entitlement";

const MESSAGING_SLUGS = ["whatsapp", "imessage", "slack", "telegram", "discord", "teams"] as const;

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export async function getNextTiles(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(auth.access_token);
  const tenant_id = auth.tenant_id;
  const failed = new Set<GrowthPlanSection>();

  try {
    const plan = await readPlan(sb, tenant_id, failed);

    const [planChannels, drafting, agentsRes, messagingRes, progressRes] = await Promise.all([
      plan ? readPlanChannelSlugs(sb, tenant_id, plan.id, failed) : Promise.resolve([]),
      isGrowthDraftInFlight(sb, tenant_id),
      sb
        .from("agent_runs")
        .select("channel_slug, status, agent_definition_hash")
        .eq("tenant_id", tenant_id)
        .not("channel_slug", "is", null)
        .order("enqueued_at", { ascending: false, nullsFirst: false })
        .limit(200),
      sb
        .from("connector_metadata")
        .select("slug", { count: "exact", head: true })
        .eq("tenant_id", tenant_id)
        .in("slug", [...MESSAGING_SLUGS]),
      sb
        .from("tenant_first_run_progress")
        .select("plan_opened_at, asked, made")
        .eq("tenant_id", tenant_id)
        .maybeSingle(),
    ]);

    if (failed.size > 0) throw new Error(`growth plan read failed: ${[...failed].join(",")}`);
    if (agentsRes.error) throw new Error(`agent_runs: ${agentsRes.error.message}`);
    if (messagingRes.error) throw new Error(`connector_metadata: ${messagingRes.error.message}`);
    if (progressRes.error) throw new Error(`tenant_first_run_progress: ${progressRes.error.message}`);

    const channelStatus: Record<string, string | null> = {};
    for (const row of (agentsRes.data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.channel_slug !== "string" || row.channel_slug in channelStatus) continue;
      if (isRecordOnlyRun(row.agent_definition_hash)) continue;
      channelStatus[row.channel_slug] = typeof row.status === "string" ? row.status : null;
    }

    let locksKnown = true;
    const locked = await annotateLockedTier(
      CHANNELS.map((c) => ({ slug: c.slug })),
      tenant_id,
      () => {
        locksKnown = false;
      },
    );
    const channelLocks: Record<string, string | null> | null = locksKnown
      ? Object.fromEntries(locked.map((l) => [l.slug, l.locked_tier]))
      : null;

    const progress = (progressRes.data ?? null) as Record<string, unknown> | null;
    const input: NextTilesInput = {
      plan: plan ? "ready" : drafting ? "drafting" : "none",
      planOpened: typeof progress?.plan_opened_at === "string",
      planChannels,
      channelStatus,
      channelLocks,
      messagingConnected: (messagingRes.count ?? 0) > 0,
      asked: stringMap(progress?.asked),
      made: stringMap(progress?.made),
    };

    res.json({ tiles: resolveNextTiles(input), first_run_done: isFirstRunDone(input) });
  } catch (e) {
    console.warn(
      `[next-tiles] read failed for tenant=${tenant_id}, serving defaults: ${(e as Error).message}`,
    );
    res.json({ tiles: DEFAULT_NEXT_TILES, first_run_done: false, degraded: true });
  }
}

const THINK_SET = new Set(NEXT_TILE_THINK_PROMPTS.map((p) => p.prompt));
const MAKE_SET = new Set(NEXT_TILE_MAKE_PROMPTS.map((p) => p.prompt));

const MarkBody = z.object({
  kind: z.enum(["plan_opened", "asked", "made"]),
  key: z.string().max(300).default(""),
});

export async function postNextTilesMark(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = MarkBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: parsed.error.message } });
    return;
  }
  const { kind, key } = parsed.data;
  if ((kind === "asked" && !THINK_SET.has(key)) || (kind === "made" && !MAKE_SET.has(key))) {
    res.status(400).json({ error: { code: "validation", message: "unknown prompt" } });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { error } = await sb.rpc("mark_first_run_progress", {
    p_tenant_id: auth.tenant_id,
    p_kind: kind,
    p_key: kind === "plan_opened" ? "plan" : key,
  });
  if (error) {
    console.warn("[next-tiles] mark_first_run_progress failed:", error.message);
  }
  res.status(204).end();
}
