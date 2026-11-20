
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { BUILD_REASONS, type BuildReason } from "@/services/sites/build-feedback-reasons";

const NODES = 4;
const ROWS_MAX = 2000;
const BUILDS_SHOWN = 200;
const COMMENTS_MAX = 10;
const IN_CHUNK = 100;

export type BuildQualityVerdict = "failed" | "needs_review" | "clean" | "insufficient_data" | "in_progress";

export type QualityRunInput = {
  id: string;
  tenant_id: string;
  status: string;
  created_at: string;
  objective: string | null;
  parent_id: string | null;
  republish: boolean;
  nodes: Array<{
    site_id: string | null;
    refine_mode: boolean;
    repair_attempts: number;
    site_repair_attempts: number;
    vision_qualifying: number | null;
    vision_status: string | null;
    vision_fix_outcome: string | null;
  }>;
};
export type QualityFeedbackInput = { target_id: string; rating: number | null; comment: string | null; build_reasons?: unknown };
export type QualityFidelityInput = {
  site_id: string;
  fidelity: { found?: unknown; total?: unknown; gross?: unknown } | null;
  chosen_direction?: string | null;
  build_direction?: string | null;
  industry?: string | null;
};

export type FeedbackGroup = { key: string; rated: number; up: number; down: number; down_share_low: number | null };
export type FeedbackBreakdown = {
  downs: number;
  by_reason: Array<{ reason: BuildReason; down: number; share_low: number | null }> | null;
  by_look: FeedbackGroup[];
  by_industry: FeedbackGroup[];
};

export type BuildQualityRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string | null;
  site_id: string | null;
  created_at: string;
  status: string;
  objective: string | null;
  verdict: BuildQualityVerdict;
  reasons: string[];
  rating: -1 | 1 | null;
  rating_comment: string | null;
  changes: { total: number; rated: number; up: number; down: number };
  fidelity: { found: number; total: number; gross: boolean } | null;
  review: { status: string; qualifying: number; fix_outcome: string | null } | null;
  fix_passes: number;
};

export type BuildQualityReport = {
  days: number;
  scope: "real" | "all";
  summary: {
    builds: number;
    by_verdict: Record<BuildQualityVerdict, number>;
    rated: number;
    rated_good: number;
    good_share: number | null;
    good_share_low: number | null;
    change_ratings: { rated: number; up: number };
    checked: number;
    with_visible_defect: number;
    avg_fidelity: number | null;
  };
  recent_negative: Array<{ build_id: string; tenant_slug: string | null; comment: string }>;
  feedback_breakdown: FeedbackBreakdown;
  builds: BuildQualityRow[];
};

export function wilsonLow(k: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

function siteOf(run: QualityRunInput): string | null {
  return run.nodes.find((n) => n.site_id)?.site_id ?? null;
}

function isChange(run: QualityRunInput): boolean {
  return run.nodes[0]?.refine_mode === true;
}

const UNKNOWN = "unknown";

function groupsOf(tally: Map<string, { up: number; down: number }>): FeedbackGroup[] {
  return [...tally.entries()]
    .map(([key, t]) => ({ key, rated: t.up + t.down, up: t.up, down: t.down, down_share_low: wilsonLow(t.down, t.up + t.down) }))
    .sort((a, b) => (b.down_share_low ?? 0) - (a.down_share_low ?? 0) || b.rated - a.rated || a.key.localeCompare(b.key));
}

export function feedbackBreakdown(input: { runs: QualityRunInput[]; feedback: QualityFeedbackInput[]; sites: QualityFidelityInput[]; reasonsRead?: boolean }): FeedbackBreakdown {
  const siteOfRun = new Map(input.runs.filter((r) => !r.republish).map((r) => [r.id, siteOf(r)]));
  const siteInfo = new Map(input.sites.map((s) => [s.site_id, s]));
  const reasons = new Map<BuildReason, number>(BUILD_REASONS.map((r) => [r, 0]));
  const looks = new Map<string, { up: number; down: number }>();
  const industries = new Map<string, { up: number; down: number }>();
  let downs = 0;
  for (const f of input.feedback) {
    if ((f.rating !== 1 && f.rating !== -1) || !siteOfRun.has(f.target_id)) continue;
    const site = siteOfRun.get(f.target_id);
    const info = site ? siteInfo.get(site) : undefined;
    const look = info?.build_direction || info?.chosen_direction || UNKNOWN;
    const industry = info?.industry?.trim().toLowerCase() || UNKNOWN;
    for (const [map, key] of [[looks, look], [industries, industry]] as const) {
      const t = map.get(key) ?? { up: 0, down: 0 };
      if (f.rating === 1) t.up += 1;
      else t.down += 1;
      map.set(key, t);
    }
    if (f.rating !== -1) continue;
    downs += 1;
    const ticked = new Set(Array.isArray(f.build_reasons) ? f.build_reasons : []);
    for (const r of BUILD_REASONS) if (ticked.has(r)) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  return {
    downs,
    by_reason:
      input.reasonsRead === false
        ? null
        : [...reasons.entries()]
            .map(([reason, down]) => ({ reason, down, share_low: wilsonLow(down, downs) }))
            .sort((a, b) => b.down - a.down || BUILD_REASONS.indexOf(a.reason) - BUILD_REASONS.indexOf(b.reason)),
    by_look: groupsOf(looks),
    by_industry: groupsOf(industries),
  };
}

function buildReasonsMissing(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? "";
  return error.code === "42703" || (/build_reasons/.test(message) && /does not exist|schema cache/i.test(message));
}

const STOPPED: Record<string, string> = { failed: "build failed", halted: "stopped", paused: "paused, never resumed" };

export function buildQualityReport(input: {
  days: number;
  scope: "real" | "all";
  runs: QualityRunInput[];
  feedback: QualityFeedbackInput[];
  fidelity: QualityFidelityInput[];
  slugs: Record<string, string>;
  reasonsRead?: boolean;
}): BuildQualityReport {
  const ratingOf = new Map<string, { up: number; down: number; comment: string | null }>();
  for (const f of input.feedback) {
    const r = ratingOf.get(f.target_id) ?? { up: 0, down: 0, comment: null };
    if (f.rating === 1) r.up += 1;
    if (f.rating === -1) {
      r.down += 1;
      if (f.comment) r.comment = f.comment;
    }
    ratingOf.set(f.target_id, r);
  }
  const fidelityOf = new Map<string, { found: number; total: number; gross: boolean }>();
  for (const f of input.fidelity) {
    const total = num(f.fidelity?.total);
    if (!f.fidelity || total <= 0) continue;
    fidelityOf.set(f.site_id, { found: num(f.fidelity.found), total, gross: f.fidelity.gross === true });
  }

  const sorted = [...input.runs].filter((r) => !r.republish).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const builds = sorted.filter((r) => !isChange(r));
  const buildById = new Map(builds.map((b) => [b.id, b]));
  const changesOf = new Map<string, QualityRunInput[]>();
  for (const c of sorted.filter(isChange)) {
    const named = c.parent_id ? buildById.get(c.parent_id) : undefined;
    const site = siteOf(c);
    const owner =
      named && named.tenant_id === c.tenant_id
        ? named
        : site
          ? [...builds].reverse().find((b) => b.tenant_id === c.tenant_id && siteOf(b) === site && b.created_at <= c.created_at)
          : undefined;
    if (!owner) continue;
    const list = changesOf.get(owner.id) ?? [];
    list.push(c);
    changesOf.set(owner.id, list);
  }

  const rows: BuildQualityRow[] = builds.map((b) => {
    const site = siteOf(b);
    const own = ratingOf.get(b.id);
    const rating: -1 | 1 | null = own ? (own.down > 0 ? -1 : own.up > 0 ? 1 : null) : null;
    const changes = (changesOf.get(b.id) ?? []).reduce(
      (acc, c) => {
        const r = ratingOf.get(c.id);
        acc.total += 1;
        if (r && (r.up > 0 || r.down > 0)) {
          acc.rated += 1;
          if (r.down > 0) acc.down += 1;
          else acc.up += 1;
        }
        return acc;
      },
      { total: 0, rated: 0, up: 0, down: 0 },
    );
    const reviewed = b.nodes.filter((n) => n.vision_status !== null);
    const last = reviewed[reviewed.length - 1];
    const review = last ? { status: last.vision_status!, qualifying: last.vision_qualifying ?? 0, fix_outcome: last.vision_fix_outcome } : null;
    const fidelity = site ? (fidelityOf.get(site) ?? null) : null;
    const fix_passes = b.nodes.reduce((n, x) => n + x.repair_attempts + x.site_repair_attempts, 0);
    const reasons: string[] = [];
    let verdict: BuildQualityVerdict;
    if (STOPPED[b.status]) {
      verdict = "failed";
      reasons.push(STOPPED[b.status]!);
    } else if (b.status !== "done") {
      verdict = "in_progress";
    } else {
      if (rating === -1) reasons.push("founder rated it bad");
      if (changes.down > 0) reasons.push(`${changes.down} change${changes.down === 1 ? "" : "s"} rated bad`);
      if (review && review.qualifying > 0) reasons.push(`${review.qualifying} visible defect${review.qualifying === 1 ? "" : "s"} at publish`);
      if (fidelity?.gross) reasons.push("site missed most of its plan");
      const checked = review?.status === "reviewed" || fidelity !== null;
      verdict = reasons.length > 0 ? "needs_review" : checked || rating === 1 ? "clean" : "insufficient_data";
    }
    if (fix_passes > 0) reasons.push(`${fix_passes} fix pass${fix_passes === 1 ? "" : "es"}`);
    return {
      id: b.id,
      tenant_id: b.tenant_id,
      tenant_slug: input.slugs[b.tenant_id] ?? null,
      site_id: site,
      created_at: b.created_at,
      status: b.status,
      objective: b.objective ? b.objective.slice(0, 140) : null,
      verdict,
      reasons,
      rating,
      rating_comment: rating === -1 ? (own?.comment ?? null) : null,
      changes,
      fidelity,
      review,
      fix_passes,
    };
  });

  const by_verdict: Record<BuildQualityVerdict, number> = { failed: 0, needs_review: 0, clean: 0, insufficient_data: 0, in_progress: 0 };
  for (const r of rows) by_verdict[r.verdict] += 1;
  const rated = rows.filter((r) => r.rating !== null);
  const ratedGood = rated.filter((r) => r.rating === 1).length;
  const fidelities = rows.map((r) => r.fidelity).filter((f): f is NonNullable<typeof f> => f !== null);
  const changeRated = rows.reduce((n, r) => n + r.changes.rated, 0);
  const changeUp = rows.reduce((n, r) => n + r.changes.up, 0);
  const order: Record<BuildQualityVerdict, number> = { failed: 0, needs_review: 1, insufficient_data: 2, in_progress: 3, clean: 4 };
  const newestFirst = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    days: input.days,
    scope: input.scope,
    summary: {
      builds: rows.length,
      by_verdict,
      rated: rated.length,
      rated_good: ratedGood,
      good_share: rated.length ? ratedGood / rated.length : null,
      good_share_low: wilsonLow(ratedGood, rated.length),
      change_ratings: { rated: changeRated, up: changeUp },
      checked: rows.filter((r) => r.review?.status === "reviewed" || r.fidelity !== null).length,
      with_visible_defect: rows.filter((r) => (r.review?.qualifying ?? 0) > 0).length,
      avg_fidelity: fidelities.length ? fidelities.reduce((s, f) => s + f.found / f.total, 0) / fidelities.length : null,
    },
    recent_negative: newestFirst
      .filter((r) => r.rating_comment)
      .slice(0, COMMENTS_MAX)
      .map((r) => ({ build_id: r.id, tenant_slug: r.tenant_slug, comment: r.rating_comment! })),
    feedback_breakdown: feedbackBreakdown({ runs: input.runs, feedback: input.feedback, sites: input.fidelity, reasonsRead: input.reasonsRead }),
    builds: [...rows]
      .sort((a, b) => order[a.verdict] - order[b.verdict] || b.created_at.localeCompare(a.created_at))
      .slice(0, BUILDS_SHOWN),
  };
}

function nodeSelect(): string {
  const parts: string[] = [];
  for (let i = 0; i < NODES; i++) {
    const p = `goal_graph->${i}`;
    parts.push(
      `s${i}:${p}->payload->>site_id`,
      `r${i}:${p}->payload->>refine_mode`,
      `a${i}:${p}->>repair_attempts`,
      `sa${i}:${p}->>site_repair_attempts`,
      `vq${i}:${p}->payload->site_vision->counts->>qualifying`,
      `vs${i}:${p}->payload->site_vision->>status`,
      `vf${i}:${p}->payload->site_vision_fix->>outcome`,
    );
  }
  parts.push("p0:goal_graph->0->payload->>parent_conductor_run_id", "rp0:goal_graph->0->payload->>republish");
  return parts.join(", ");
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function toQualityRun(row: Record<string, unknown>): QualityRunInput {
  const nodes: QualityRunInput["nodes"] = [];
  for (let i = 0; i < NODES; i++) {
    const present = ["s", "r", "a", "sa", "vq", "vs", "vf"].some((k) => row[`${k}${i}`] !== null && row[`${k}${i}`] !== undefined);
    if (!present) continue;
    const vq = row[`vq${i}`];
    nodes.push({
      site_id: str(row[`s${i}`]),
      refine_mode: row[`r${i}`] === "true" || row[`r${i}`] === true,
      repair_attempts: num(row[`a${i}`]),
      site_repair_attempts: num(row[`sa${i}`]),
      vision_qualifying: vq === null || vq === undefined ? null : num(vq),
      vision_status: str(row[`vs${i}`]),
      vision_fix_outcome: str(row[`vf${i}`]),
    });
  }
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    status: String(row.status ?? ""),
    created_at: String(row.created_at ?? ""),
    objective: str(row.objective),
    parent_id: str(row.p0),
    republish: row.rp0 === "true" || row.rp0 === true,
    nodes,
  };
}

export async function staffBuildQuality(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days ?? 14)) || 14));
  const scope: "real" | "all" = req.query.scope === "all" ? "all" : "real";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const sb = staffCrossTenantClient("admin/build-quality: cross-tenant staff read-only board");

  const tenantsQ = await sb.from("tenants").select("id, slug, kind").limit(10000);
  if (tenantsQ.error) {
    res.status(500).json({ error: { code: "build_quality_query_failed", message: tenantsQ.error.message } });
    return;
  }
  const tenants = (tenantsQ.data ?? []) as Array<{ id: string; slug: string | null; kind: string | null }>;
  const slugs = Object.fromEntries(tenants.map((t) => [t.id, t.slug ?? ""]));
  const excluded = new Set(
    scope === "real" ? tenants.filter((t) => t.kind === "test" || DOGFOOD_SLUGS.has(t.slug ?? "")).map((t) => t.id) : [],
  );

  const runsQ = await sb
    .from("conductor_runs")
    .select(`id, tenant_id, status, created_at, objective, ${nodeSelect()}`)
    .eq("kind", "build_app")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(ROWS_MAX);
  if (runsQ.error) {
    res.status(500).json({ error: { code: "build_quality_query_failed", message: runsQ.error.message } });
    return;
  }
  const runs = ((runsQ.data ?? []) as unknown as Array<Record<string, unknown>>)
    .map(toQualityRun)
    .filter((r) => !excluded.has(r.tenant_id));
  const ids = runs.map((r) => r.id);
  const sites = [...new Set(runs.map((r) => r.nodes.find((n) => n.site_id)?.site_id).filter((s): s is string => !!s))];

  const feedback: QualityFeedbackInput[] = [];
  let reasonsRead = true;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const read = (cols: string) => sb.from("agent_feedback").select(cols).eq("target_type", "conductor_run").in("target_id", ids.slice(i, i + IN_CHUNK));
    let q = await read(reasonsRead ? "target_id, rating, comment, build_reasons" : "target_id, rating, comment");
    if (q.error && reasonsRead && buildReasonsMissing(q.error)) {
      reasonsRead = false;
      q = await read("target_id, rating, comment");
    }
    if (q.error) {
      res.status(500).json({ error: { code: "build_quality_query_failed", message: q.error.message } });
      return;
    }
    feedback.push(...((q.data ?? []) as unknown as QualityFeedbackInput[]));
  }
  const fidelity: QualityFidelityInput[] = [];
  for (let i = 0; i < sites.length; i += IN_CHUNK) {
    const q = await sb.from("site_design_briefs").select("site_id, fidelity, chosen_direction, build_direction, industry:brief->>industry").in("site_id", sites.slice(i, i + IN_CHUNK));
    if (q.error) {
      res.status(500).json({ error: { code: "build_quality_query_failed", message: q.error.message } });
      return;
    }
    fidelity.push(...((q.data ?? []) as QualityFidelityInput[]));
  }

  res.json(buildQualityReport({ days, scope, runs, feedback, fidelity, slugs, reasonsRead }));
}
