
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { CURRENT_STRATEGY_TAG } from "@/services/growth/strategy-note";
import type { BasisEvidence, ParsedStrategy } from "@/agents/cgo/strategy";
import { parsePlanDetail } from "@/agents/cgo/strategy";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { marketingUrlOf } from "@/services/brand/resolve-brand-kit";
import {
  channelReadiness,
  type ChannelReadiness,
} from "@/services/growth/channel-readiness";

export type GrowthStrategyResponse = {
  strategy: ParsedStrategy | null;
  intake_started: boolean;
  accepted: boolean;
  updated_at: string | null;
  readiness: ChannelReadiness[];
};

const KNOWN_CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.slug));

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function projectStrategy(raw: unknown): ParsedStrategy | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const ns = (o.north_star ?? {}) as Record<string, unknown>;
  const c = (o.constraint ?? {}) as Record<string, unknown>;
  const metric = str(ns.metric).trim();
  const statement = str(c.statement).trim();
  if (!metric || !statement) return null;

  const conf = str(c.confidence);
  const confidence = conf === "high" || conf === "medium" || conf === "low" ? conf : "low";

  const bets = (Array.isArray(o.channel_bets) ? o.channel_bets : [])
    .slice(0, 3)
    .map((b) => {
      const bb = (b ?? {}) as Record<string, unknown>;
      return {
        channel_slug: str(bb.channel_slug),
        intent: str(bb.intent),
        rationale: str(bb.rationale),
        expected_effect: str(bb.expected_effect),
        falsifier: str(bb.falsifier),
      };
    })
    .filter((b) => b.channel_slug.length > 0 && KNOWN_CHANNEL_SLUGS.has(b.channel_slug) && !RETIRED_CHANNEL_SLUGS.has(b.channel_slug));

  let goal: ParsedStrategy["goal"] = null;
  const g = (o.goal ?? {}) as Record<string, unknown>;
  const gv = typeof g.target_value === "number" ? g.target_value : NaN;
  if (str(g.objective) && str(g.target_metric) && Number.isFinite(gv) && str(g.due_date)) {
    goal = {
      objective: str(g.objective),
      target_metric: str(g.target_metric),
      target_value: gv,
      due_date: str(g.due_date),
    };
  }

  return {
    north_star: { metric, why: str(ns.why), provenance: str(ns.provenance) },
    constraint: {
      statement,
      lever_family: str(c.lever_family),
      evidence: str(c.evidence),
      confidence,
    },
    channel_bets: bets,
    goal,
    gaps: (Array.isArray(o.gaps) ? o.gaps : []).map(str).filter(Boolean).slice(0, 5),
    unmeasured: (Array.isArray(o.unmeasured) ? o.unmeasured : [])
      .map((u) => {
        const uu = (u ?? {}) as Record<string, unknown>;
        return {
          lever: str(uu.lever),
          the_one_read_that_would_size_it: str(uu.the_one_read_that_would_size_it),
        };
      })
      .filter((u) => u.lever.length > 0),
    basis_evidence: (Array.isArray(o.basis_evidence) ? o.basis_evidence : [])
      .map((e) => {
        const ee = (e ?? {}) as Record<string, unknown>;
        return {
          kind: str(ee.kind) as BasisEvidence["kind"],
          source: str(ee.source),
          statement: str(ee.statement),
        };
      })
      .filter(
        (e) =>
          e.statement.length > 0 &&
          (["founder", "platform", "site", "inferred", "gap"] as string[]).includes(
            e.kind,
          ),
      ),
    ...parsePlanDetail(o),
  };
}

async function readinessFor(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  strategy: ParsedStrategy | null,
): Promise<ChannelReadiness[]> {
  if (!strategy || strategy.channel_bets.length === 0) return [];
  try {
    const [{ data: conn }, { data: ten }] = await Promise.all([
      sb.from("connector_metadata").select("slug").eq("tenant_id", tenant_id),
      sb.from("tenants").select("product_url").eq("id", tenant_id).limit(1),
    ]);
    const linked = new Set(
      ((conn ?? []) as Array<{ slug: string }>).map((c) => c.slug),
    );
    const hasSite = marketingUrlOf(
      (ten?.[0] as { product_url?: unknown } | undefined)?.product_url,
    ) !== null;
    return strategy.channel_bets.map((b) =>
      channelReadiness(b.channel_slug, linked, hasSite),
    );
  } catch {
    return [];
  }
}

export function intakeStarted(meta: Record<string, unknown> | null): boolean {
  const interview = (meta?.interview ?? {}) as {
    answers?: Record<string, unknown>;
    skipped?: unknown;
  };
  if (interview.skipped === true) return true;
  const answers = interview.answers;
  if (!answers || typeof answers !== "object") return false;
  return Object.keys(answers).length > 0;
}

export async function workspaceGrowthStrategy(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(auth.access_token);
  const empty: GrowthStrategyResponse = {
    strategy: null,
    intake_started: false,
    accepted: false,
    updated_at: null,
    readiness: [],
  };

  try {
    const { data, error } = await sb
      .from("memory_note")
      .select("metadata, updated_at")
      .eq("tenant_id", auth.tenant_id)
      .eq("note_type", "growth_strategy")
      .contains("tags", [CURRENT_STRATEGY_TAG])
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error || !Array.isArray(data) || !data[0]) {
      res.json(empty);
      return;
    }
    const row = data[0] as Record<string, unknown>;
    const meta = (row.metadata ?? null) as Record<string, unknown> | null;
    const strategy = projectStrategy(meta?.strategy ?? null);
    res.json({
      strategy,
      intake_started: intakeStarted(meta),
      readiness: await readinessFor(sb, auth.tenant_id, strategy),
      accepted: strategy !== null && meta?.accepted === true,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    } satisfies GrowthStrategyResponse);
  } catch {
    res.json(empty);
  }
}
