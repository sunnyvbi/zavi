import { inngest } from "../client";
import { recordScreenCheck } from "@/services/agents/conductor";
import type { ConductorNode } from "@/services/agents/conductor";
import {
  conductorScreenCheckClient,
  realConductorTickDeps,
} from "@/services/agents/conductor-driver";
import { targetedRunId } from "@/services/agents/conductor-kick";
import type { ScreenCheckRecord } from "@/services/qa/post-deploy-screen-check";

export const BUILD_SCREEN_CHECK_REQUESTED = "build/screen-check.requested" as const;

const MAX_WRITE_ATTEMPTS = 3;

export async function requestBuildScreenCheck(data: {
  conductor_run_id: string;
  node_id: string;
}): Promise<void> {
  await inngest.send({ name: BUILD_SCREEN_CHECK_REQUESTED, data });
}

type Svc = ReturnType<typeof conductorScreenCheckClient>;

export type BuildScreenCheckDeps = {
  svc: Svc;
  screenCheck?: (input: { tenant_id: string }) => Promise<ScreenCheckRecord>;
  now?: () => Date;
};

export type BuildScreenCheckResult =
  | { recorded: true; status: ScreenCheckRecord["status"] }
  | { skipped: true; reason: string };

type RunRow = {
  tenant_id: string;
  kind: string | null;
  goal_graph: ConductorNode[] | null;
  updated_at: string | null;
};

async function loadRun(svc: Svc, conductor_run_id: string): Promise<RunRow | null> {
  const { data, error } = await svc
    .from("conductor_runs")
    .select("tenant_id, kind, goal_graph, updated_at")
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  return (data as RunRow | null) ?? null;
}

function deployNodeOf(row: RunRow, node_id: string): ConductorNode | null {
  const node = (row.goal_graph ?? []).find((n) => n.id === node_id);
  if (!node || node.payload?.stage !== "deploy" || node.status !== "done") return null;
  return node;
}

export async function handleBuildScreenCheck(
  data: unknown,
  deps: BuildScreenCheckDeps,
): Promise<BuildScreenCheckResult> {
  const conductor_run_id = targetedRunId({ data });
  const node_id = (data as { node_id?: unknown } | null)?.node_id;
  if (!conductor_run_id || typeof node_id !== "string" || node_id.length === 0) {
    return { skipped: true, reason: "bad_request" };
  }
  if (!deps.screenCheck) return { skipped: true, reason: "screen_check_disabled" };

  const { data: halted, error: killErr } = await deps.svc.rpc("is_fleet_halted");
  if (killErr || halted === true) return { skipped: true, reason: "fleet_halted" };

  const row = await loadRun(deps.svc, conductor_run_id);
  if (!row || row.kind !== "build_app") return { skipped: true, reason: "run_not_found" };
  const node = deployNodeOf(row, node_id);
  if (!node) return { skipped: true, reason: "deploy_node_not_done" };
  if (node.screen_check) return { skipped: true, reason: "already_recorded" };

  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();
  const record = await recordScreenCheck(deps.screenCheck, row.tenant_id, nowIso);

  let current: RunRow | null = row;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && current; attempt++) {
    if (current.tenant_id !== row.tenant_id) break;
    const graph: ConductorNode[] = JSON.parse(JSON.stringify(current.goal_graph ?? []));
    const target = graph.find((n) => n.id === node_id);
    if (!target) break;
    target.screen_check = record;
    let q = deps.svc
      .from("conductor_runs")
      .update({ goal_graph: graph })
      .eq("id", conductor_run_id)
      .eq("tenant_id", row.tenant_id);
    q = current.updated_at === null ? q.is("updated_at", null) : q.eq("updated_at", current.updated_at);
    const { data: written, error } = await q.select("id");
    if (error) throw new Error(`screen check write failed: ${error.message}`);
    if ((written ?? []).length > 0) return { recorded: true, status: record.status };
    current = await loadRun(deps.svc, conductor_run_id);
  }
  return { skipped: true, reason: "graph_changed" };
}

export const buildScreenCheckFn = inngest.createFunction(
  {
    id: "build-screen-check",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.conductor_run_id" }, { limit: 5 }],
  },
  { event: BUILD_SCREEN_CHECK_REQUESTED },
  async ({ event }: { event: { data?: unknown } }) =>
    handleBuildScreenCheck(event.data, {
      svc: conductorScreenCheckClient(),
      screenCheck: realConductorTickDeps.screenCheck,
    }),
);
