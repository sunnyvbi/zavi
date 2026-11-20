
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import {
  SHADOW_CANARY_AGENTS,
  isShadowCanaryAgent,
} from "@/services/eval/engine-parity/shadow-canary-agents";

export const DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export const SHADOW_CANARY_CRON_FLAG = "shadow_canary_cron_enabled" as const;

const PER_AGENT_LIMIT = 20;

export async function isShadowCanaryCronEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob[SHADOW_CANARY_CRON_FLAG] === true;
  } catch {
    return false;
  }
}

export function isShadowCanaryTenantAllowed(tenantId: string): boolean {
  return (tenantId ?? "").trim() === DOGFOOD_TENANT;
}

export type ShadowCanaryAgentResult = {
  agent_slug: string;
  status: "ok" | "error";
  error?: string;
};

export type ShadowCanaryCronResult = {
  enabled: boolean;
  halted?: boolean;
  tenant?: string;
  agents_attempted?: number;
  results?: ShadowCanaryAgentResult[];
};

async function replayAndGradeAgent(
  agent_slug: string,
): Promise<ShadowCanaryAgentResult> {
  try {
    const { execFileSync } = await import("node:child_process");
    const dist = process.env.PRAXIS_DIST_DIR || "dist";
    const node = process.execPath;
    const common = ["-r", "tsconfig-paths/register"];
    execFileSync(
      node,
      [
        ...common,
        `${dist}/scripts/shadow-replay.js`,
        "--agent",
        agent_slug,
        "--provider",
        "bedrock",
        "--limit",
        String(PER_AGENT_LIMIT),
      ],
      { stdio: "inherit", timeout: 30 * 60_000 },
    );
    execFileSync(
      node,
      [
        ...common,
        `${dist}/scripts/shadow-grade.js`,
        "--agent",
        agent_slug,
        "--provider",
        "bedrock",
        "--limit",
        String(PER_AGENT_LIMIT),
      ],
      { stdio: "inherit", timeout: 30 * 60_000 },
    );
    return { agent_slug, status: "ok" };
  } catch (e) {
    return { agent_slug, status: "error", error: (e as Error).message };
  }
}

export async function runShadowCanaryCron(): Promise<ShadowCanaryCronResult> {
  if (!(await isShadowCanaryCronEnabled())) {
    return { enabled: false };
  }

  if (await isFleetHalted()) {
    return { enabled: true, halted: true, agents_attempted: 0, results: [] };
  }

  if (!isShadowCanaryTenantAllowed(DOGFOOD_TENANT)) {
    return { enabled: true, tenant: DOGFOOD_TENANT, agents_attempted: 0, results: [] };
  }

  const agents = [...SHADOW_CANARY_AGENTS].filter(isShadowCanaryAgent);

  const results: ShadowCanaryAgentResult[] = [];
  for (const agent_slug of agents) {
    results.push(await replayAndGradeAgent(agent_slug));
  }

  return {
    enabled: true,
    halted: false,
    tenant: DOGFOOD_TENANT,
    agents_attempted: agents.length,
    results,
  };
}

export const shadowCanaryCronFn = inngest.createFunction(
  {
    id: "shadow-canary-cron",
    concurrency: 1,
  },
  [
    { event: "agents/shadow-canary.cron.requested" },
  ],
  async () => {
    return runShadowCanaryCron();
  },
);
