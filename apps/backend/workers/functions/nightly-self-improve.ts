
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { scoreAtoms, type AtomScore } from "@/services/agents/eval/atom-scorer";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

export const NIGHTLY_SELF_IMPROVE_FLAG = "NIGHTLY_SELF_IMPROVE_ENABLED" as const;

export const NIGHTLY_FLEET_AGENT_SLUGS: readonly string[] = [
  "performance-marketer",
  "chief-of-staff",
  "engineer",
  "growth-lead",
  "operator",
  "support-lead",
  "pm",
  "qa",
  "research",
  "advisor",
];

const MAX_RUNS_PER_AGENT = 20;

const LOOKBACK_HOURS = 24;

function nightlyWindowLabel(now = new Date()): string {
  return `nightly-${now.toISOString().slice(0, 10)}`;
}

const MONEY_PATH_AGENT_SLUGS: ReadonlySet<string> = new Set([
  "performance-marketer",
  "growth-lead",
  "operator",
]);

type TenantRow = { id: string; display_name: string | null };

export type GradeableRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
  tool_calls: unknown[] | null;
  parsed: unknown;
  quality_score: number | null;
  quality_rationale: string | null;
  quality_evidence: unknown | null;
  quality_scored_at: string | null;
};

export type DigestItem = {
  tenant_id: string;
  agent_slug: string;
  run_id: string;
  kind: "e3" | "blocker" | "human_needed" | "false_negative_existence" | "low_quality";
  reason: string;
};

export type ImprovementCluster = {
  tenant_id: string;
  agent_slug: string;
  cluster_signature: ImprovementSignature;
  run_ids: string[];
  digest_reason: ImprovementReason;
};

export type ImprovementSignature =
  | "e3"
  | "blocker"
  | "human_needed"
  | "false_negative_existence"
  | "low_quality";

export type ImprovementReason =
  | "money_path_ungrounded_number"
  | "ungrounded_number"
  | "no_verifiable_atoms"
  | "false_negative_existence"
  | "low_quality_score";

function reasonForKind(kind: DigestItem["kind"]): ImprovementReason {
  switch (kind) {
    case "e3":
      return "money_path_ungrounded_number";
    case "human_needed":
      return "ungrounded_number";
    case "blocker":
      return "no_verifiable_atoms";
    case "false_negative_existence":
      return "false_negative_existence";
    case "low_quality":
      return "low_quality_score";
  }
}

const SIGNATURE_PRIORITY: readonly ImprovementSignature[] = [
  "false_negative_existence",
  "e3",
  "blocker",
  "human_needed",
  "low_quality",
];

export type NightlyResult = {
  enabled: boolean;
  halted?: boolean;
  tenants_scanned?: number;
  runs_graded?: number;
  digest?: DigestItem[];
  improvement_rows_written?: number;
};

export async function scopedRecentRunIds(args: {
  tenant_id: string;
  agent_slug: string;
  sinceIso: string;
  limit?: number;
}): Promise<string[]> {
  const tenant_id = (args.tenant_id ?? "").trim();
  if (!tenant_id) {
    throw new Error(
      "nightly-self-improve: refusing a tenant-less agent_runs read (contract 5)",
    );
  }
  const agent_slug = (args.agent_slug ?? "").trim();
  if (!agent_slug) {
    throw new Error("nightly-self-improve: scopedRecentRunIds requires an agent_slug");
  }

  const sb = serviceClient();
  const { data, error } = await sb
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", agent_slug)
    .eq("status", "success")
    .gte("started_at", args.sinceIso)
    .order("started_at", { ascending: false })
    .limit(args.limit ?? MAX_RUNS_PER_AGENT);
  if (error) {
    throw new Error(`nightly-self-improve: scopedRecentRunIds failed: ${error.message}`);
  }
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function loadRunForTenant(
  run_id: string,
  expectTenantId: string,
): Promise<GradeableRunRow | null> {
  const expect = (expectTenantId ?? "").trim();
  if (!expect) {
    throw new Error("nightly-self-improve: loadRunForTenant requires expectTenantId");
  }
  const sb = serviceClient();
  const { data, error } = await sb
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, status, output_text, tool_calls, parsed, " +
        "quality_score, quality_rationale, quality_evidence, quality_scored_at",
    )
    .eq("id", run_id)
    .maybeSingle();
  if (error) {
    throw new Error(`nightly-self-improve: loadRunForTenant failed: ${error.message}`);
  }
  if (!data) return null;
  const row = data as unknown as GradeableRunRow;
  if (row.tenant_id !== expect) return null;
  return row;
}

const LOW_QUALITY_BAR = 40;

export function gradeRunForDigest(run: GradeableRunRow): DigestItem[] {
  const items: DigestItem[] = [];

  if (
    typeof run.quality_score === "number" &&
    run.quality_score < 50 &&
    run.quality_evidence != null &&
    run.quality_scored_at
  ) {
    items.push({
      tenant_id: run.tenant_id,
      agent_slug: run.agent_slug,
      run_id: run.id,
      kind: "false_negative_existence",
      reason: "repo-grounded false negative-existence claim (quality_score<50)",
    });
  }

  const firedNegExistence =
    typeof run.quality_score === "number" &&
    run.quality_score < 50 &&
    run.quality_evidence != null &&
    run.quality_scored_at != null;
  if (
    !firedNegExistence &&
    typeof run.quality_score === "number" &&
    run.quality_score < LOW_QUALITY_BAR &&
    run.quality_scored_at != null
  ) {
    items.push({
      tenant_id: run.tenant_id,
      agent_slug: run.agent_slug,
      run_id: run.id,
      kind: "low_quality",
      reason: `cross-model run-scorer judged low quality (score<${LOW_QUALITY_BAR})`,
    });
  }

  const score: AtomScore = scoreAtoms({
    outputText: run.output_text ?? "",
    toolCalls: Array.isArray(run.tool_calls) ? run.tool_calls : [],
    decisionBody: run.parsed,
  });

  const failedNumberAtom = score.atoms.find(
    (a) => a.kind === "number" && a.verdict === "fail",
  );
  if (failedNumberAtom && MONEY_PATH_AGENT_SLUGS.has(run.agent_slug)) {
    items.push({
      tenant_id: run.tenant_id,
      agent_slug: run.agent_slug,
      run_id: run.id,
      kind: "e3",
      reason: `money-path agent emitted an ungrounded number (${failedNumberAtom.text})`,
    });
  }

  if (
    score.total > 0 &&
    score.coverage === 0 &&
    MONEY_PATH_AGENT_SLUGS.has(run.agent_slug)
  ) {
    items.push({
      tenant_id: run.tenant_id,
      agent_slug: run.agent_slug,
      run_id: run.id,
      kind: "blocker",
      reason: "no mechanically-verifiable atoms (all unverifiable prose)",
    });
  }

  return items;
}

export function clusterizeTenantDigest(args: {
  tenant_id: string;
  items: DigestItem[];
  gradedRunIdsByAgent: Map<string, string[]>;
}): ImprovementCluster[] {
  const { tenant_id, items, gradedRunIdsByAgent } = args;

  const byAgent = new Map<string, DigestItem[]>();
  for (const item of items) {
    const arr = byAgent.get(item.agent_slug);
    if (arr) arr.push(item);
    else byAgent.set(item.agent_slug, [item]);
  }

  const clusters: ImprovementCluster[] = [];
  for (const [agent_slug, agentItems] of byAgent) {
    const kinds = new Set(agentItems.map((i) => i.kind));
    const signature = SIGNATURE_PRIORITY.find((s) => kinds.has(s));
    if (!signature) continue;
    clusters.push({
      tenant_id,
      agent_slug,
      cluster_signature: signature,
      run_ids: gradedRunIdsByAgent.get(agent_slug) ?? [],
      digest_reason: reasonForKind(signature),
    });
  }
  return clusters;
}

export async function gradeTenant(
  tenant_id: string,
  sinceIso: string,
): Promise<{ items: DigestItem[]; graded: number; clusters: ImprovementCluster[] }> {
  const items: DigestItem[] = [];
  const gradedRunIdsByAgent = new Map<string, string[]>();
  let graded = 0;

  for (const agent_slug of NIGHTLY_FLEET_AGENT_SLUGS) {
    let runIds: string[];
    try {
      runIds = await scopedRecentRunIds({ tenant_id, agent_slug, sinceIso });
    } catch (e) {
      console.warn(
        `[nightly-self-improve] tenant=${tenant_id} agent=${agent_slug} ` +
          `list failed: ${(e as Error).message}`,
      );
      continue;
    }

    for (const run_id of runIds) {
      const run = await loadRunForTenant(run_id, tenant_id);
      if (!run) continue;
      graded++;
      const seen = gradedRunIdsByAgent.get(agent_slug);
      if (seen) seen.push(run.id);
      else gradedRunIdsByAgent.set(agent_slug, [run.id]);
      items.push(...gradeRunForDigest(run));
    }
  }

  const clusters = clusterizeTenantDigest({ tenant_id, items, gradedRunIdsByAgent });
  return { items, graded, clusters };
}

export async function writeImprovementRows(
  clusters: ImprovementCluster[],
  window: string,
): Promise<number> {
  if (clusters.length === 0) return 0;
  const sb = serviceClient();
  let written = 0;

  for (const cluster of clusters) {
    if (cluster.run_ids.length === 0) continue;

    try {
      const { data, error } = await sb.rpc("create_improvement_request", {
        p_tenant_id: cluster.tenant_id,
        p_agent_slug: cluster.agent_slug,
        p_cluster_signature: cluster.cluster_signature,
        p_run_ids: cluster.run_ids,
        p_digest_reason: cluster.digest_reason,
        p_window: window,
      });
      if (error) {
        console.warn(
          `[nightly-self-improve] create_improvement_request failed tenant=${cluster.tenant_id} ` +
            `agent=${cluster.agent_slug} sig=${cluster.cluster_signature}: ${error.message}`,
        );
        continue;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.inserted) written++;
    } catch (e) {
      console.warn(
        `[nightly-self-improve] create_improvement_request threw tenant=${cluster.tenant_id} ` +
          `agent=${cluster.agent_slug}: ${(e as Error).message}`,
      );
    }
  }
  return written;
}

export async function runNightlySelfImprove(): Promise<NightlyResult> {
  const _f = process.env[NIGHTLY_SELF_IMPROVE_FLAG];
  if (_f === "0" || _f === "false") {
    return { enabled: false };
  }

  if (await isFleetHalted()) {
    return { enabled: true, halted: true, tenants_scanned: 0, runs_graded: 0, digest: [] };
  }

  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  const sb = serviceClient();
  const { data: tData, error: tErr } = await sb
    .from("tenants")
    .select("id, display_name");
  if (tErr) {
    throw new Error(`nightly-self-improve: tenant scan failed: ${tErr.message}`);
  }
  const tenants = (tData ?? []) as TenantRow[];

  const digest: DigestItem[] = [];
  const clusters: ImprovementCluster[] = [];
  let runsGraded = 0;
  for (const tenant of tenants) {
    try {
      const { items, graded, clusters: tClusters } = await gradeTenant(tenant.id, sinceIso);
      runsGraded += graded;
      digest.push(...items);
      clusters.push(...tClusters);
    } catch (e) {
      console.error(
        `[nightly-self-improve] tenant=${tenant.id} threw: ${(e as Error).message}`,
      );
    }
  }

  const window = nightlyWindowLabel();
  let improvementRowsWritten = 0;
  try {
    improvementRowsWritten = await writeImprovementRows(clusters, window);
  } catch (e) {
    console.error(
      `[nightly-self-improve] writeImprovementRows threw: ${(e as Error).message}`,
    );
  }

  return {
    enabled: true,
    halted: false,
    tenants_scanned: tenants.length,
    runs_graded: runsGraded,
    digest,
    improvement_rows_written: improvementRowsWritten,
  };
}

export const nightlySelfImproveFn = inngest.createFunction(
  {
    id: "nightly-self-improve",
    concurrency: 1,
  },
  [
    { cron: "0 8 * * *" },
    { event: "agents/nightly.self-improve.requested" },
  ],
  async ({ event }) => {
    const isManualFire = event?.name === "agents/nightly.self-improve.requested";
    if (!isManualFire && isWorkerCronStopped("nightly-self-improve")) {
      return { enabled: false, cron_stopped: true as const };
    }
    return runNightlySelfImprove();
  },
);
