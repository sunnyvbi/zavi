
import type { DesignBrief } from "@/services/sites/design-brief";
import type { ConductorNode } from "@/services/agents/conductor";
import { tenantScopedSlug } from "@/services/provisioning/tenant-slug";
import { resolveShowabilityGateMode } from "@/services/qa/showability-gate";
import { archetypeHintFor } from "@/services/agents/archetype-kits/registry";
import {
  AUTOPILOT_BUILD_STACK,
  REFERENCE_IMAGES_INSTRUCTION,
  STAGE_AGENT,
  type PipelineStage,
  type BuildProductInput,
  type BuildProductGraph,
  type ProvisionedTarget,
} from "@/services/agents/autopilot-pipeline-contract";

const BASE_PIPELINE_STAGES: readonly PipelineStage[] = [
  "provision",
  "spec",
  "scaffold",
  "build",
] as const;

const STAGE_ESTIMATE_USD: Record<string, number> = {
  repo_analysis: 0.75,
  provision: 0.10,
  spec: 0.50,
  scaffold: 1.00,
  preview: 0,
  build: 3.00,
  qa: 0,
  deploy: 0,
};

export const REPO_ANALYSIS_BRIEF = [
  "You are extending an EXISTING repository, not scaffolding a new one.",
  "Run READ-ONLY. Do not edit files, do not open a PR, do not run destructive commands.",
  "Deeply analyze the repo and report, grounded in the actual files you read:",
  "  1. STRUCTURE — top-level layout, monorepo/workspaces, entry points, routing.",
  "  2. STACK — language(s), framework + version, package manager, build/run commands.",
  "  3. DESIGN TOKENS — color/typography/spacing system, component library, theme source.",
  "  4. DB SCHEMA — migrations/ORM, tables already defined, how schema changes are applied.",
  "  5. AUTH — how users authenticate + how authorization/tenant-scoping is enforced.",
  "  6. TESTS — test runner + how to run the existing suite (these MUST keep passing).",
  "  7. DEPLOY CONFIG — CI, hosting, env-var contract, migration-apply step.",
  "  8. CONVENTIONS — lint rules, naming, error-handling, file-organization norms to match.",
  "Then produce an EXTENSION PLAN for the founder's idea that:",
  "  - lists exactly which files/modules to ADD and which existing ones to TOUCH minimally;",
  "  - PRESERVES current behavior (no overwrite of existing routes/schema/auth);",
  "  - reuses the repo's own design tokens + conventions rather than introducing new ones;",
  "  - keeps the existing test suite green and adds tests for the new surface;",
  "  - flags any change that touches money/auth/PII/tenant-isolation for human review.",
].join("\n");

function repoAnalysisStageEnabled(): boolean {
  return process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED === "1";
}

function deployStageEnabled(): boolean {
  return process.env.BUILD_DEPLOY_STAGE_ENABLED !== "0";
}

export type BuildProductGraphOpts = {
  provisioned?: ProvisionedTarget;
};

export function buildProductGoalGraph(
  input: BuildProductInput,
  opts: BuildProductGraphOpts = {},
): BuildProductGraph {
  const companySlug = tenantScopedSlug(input.company_name, input.tenant_id, 200);
  const target = opts.provisioned;
  const provisionedAtEnqueue = target !== undefined;

  const archetype = archetypeHintFor(input.idea);
  const references = input.reference_images?.length
    ? { reference_images: input.reference_images, reference_images_instruction: REFERENCE_IMAGES_INSTRUCTION }
    : {};

  const stages: PipelineStage[] = [...BASE_PIPELINE_STAGES];
  if (deployStageEnabled()) stages.push("deploy");

  if (repoAnalysisStageEnabled() && target !== undefined) {
    stages.unshift("repo_analysis");
  }

  const nodes: ConductorNode[] = stages.map((stage) => {
    const id = `${companySlug}-${stage}`;

    let payload: Record<string, unknown>;
    switch (stage) {
      case "repo_analysis":
        payload = {
          stage,
          idea: input.idea,
          company_name: input.company_name,
          target: target!,
          existing_repo: true,
          analysis_brief: REPO_ANALYSIS_BRIEF,
        };
        break;
      case "provision":
        payload = {
          stage,
          company_name: input.company_name,
          stack: AUTOPILOT_BUILD_STACK,
          dry_run: !provisionedAtEnqueue,
          ...(provisionedAtEnqueue ? { provisioned: target } : {}),
        };
        break;
      case "spec":
        payload = { stage, idea: input.idea, archetype, ...references, ...(target ? { target } : {}) };
        break;
      case "scaffold":
        payload = {
          stage,
          stack: AUTOPILOT_BUILD_STACK,
          idea: input.idea,
          company_name: input.company_name,
          archetype,
          ...references,
          ...(target ? { target } : {}),
        };
        break;
      case "preview":
        payload = { stage, placeholder: true };
        break;
      case "build":
        payload = {
          stage,
          stack: AUTOPILOT_BUILD_STACK,
          idea: input.idea,
          company_name: input.company_name,
          ...references,
          ...(target ? { target } : {}),
        };
        break;
      case "qa":
        payload = { stage, ...(target ? { target } : {}) };
        break;
      case "deploy": {
        const showability = resolveShowabilityGateMode();
        payload =
          showability === "off" ? { stage } : { stage, showability_gate_mode: showability };
        break;
      }
    }

    return {
      id,
      status: stage === "provision" && provisionedAtEnqueue ? "done" : "pending",
      target_agent_slug: STAGE_AGENT[stage],
      payload: { ...payload, memory_mode: "off" },
      estimate_usd: STAGE_ESTIMATE_USD[stage],
      child_run_id: null,
    };
  });

  return nodes;
}

export const SITE_BUILD_STACK = "vite-react-supabase" as const;

export type SiteGraphOpts = {
  site_id: string;
  target: ProvisionedTarget;
  seed_sha: string;
  reference_images?: string[];
  provision_started_at?: string;
  provision_finished_at?: string;
  site_backend?: SiteBackendKind;
  publish_on_request: boolean;
  design_brief?: DesignBrief;
  await_look?: boolean;
};

export type SiteBackendKind = "pooled" | "dedicated";

export function buildSiteGoalGraph(input: BuildProductInput, opts: SiteGraphOpts): BuildProductGraph {
  const companySlug = tenantScopedSlug(input.company_name, input.tenant_id, 200);
  const target: ProvisionedTarget = { ...opts.target, github_target_mode: "umbrella" };
  const base = { site_id: opts.site_id, memory_mode: "off", ...(opts.site_backend ? { site_backend: opts.site_backend } : {}) };
  const graph: BuildProductGraph = [
    {
      id: `${companySlug}-provision`,
      status: "done",
      target_agent_slug: STAGE_AGENT.provision,
      payload: {
        stage: "provision",
        company_name: input.company_name,
        stack: SITE_BUILD_STACK,
        dry_run: false,
        provisioned: target,
        ...base,
      },
      estimate_usd: STAGE_ESTIMATE_USD.provision,
      child_run_id: null,
      started_at: opts.provision_started_at ?? null,
      finished_at: opts.provision_finished_at ?? null,
      error: null,
      failure_class: null,
    },
    {
      id: `${companySlug}-build`,
      status: "pending",
      target_agent_slug: STAGE_AGENT.build,
      payload: {
        stage: "build",
        fast_single_pass: true,
        stack: SITE_BUILD_STACK,
        idea: input.idea,
        company_name: input.company_name,
        target,
        ...(opts.reference_images?.length ? { reference_images: opts.reference_images.slice(0, 3) } : {}),
        ...(opts.design_brief ? { design_brief: opts.design_brief } : {}),
        ...(opts.await_look === true ? { await_look: true } : {}),
        ...base,
      },
      estimate_usd: STAGE_ESTIMATE_USD.build,
      child_run_id: null,
    },
  ];
  if (opts.publish_on_request) return graph;
  graph.push({
    id: `${companySlug}-deploy`,
    status: "pending",
    target_agent_slug: STAGE_AGENT.deploy,
    payload: { stage: "deploy", seed_sha: opts.seed_sha, ...base },
    estimate_usd: STAGE_ESTIMATE_USD.deploy,
    child_run_id: null,
  });
  return graph;
}
