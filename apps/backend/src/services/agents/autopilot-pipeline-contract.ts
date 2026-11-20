
import type { ConductorNode } from "@/services/agents/conductor";

export const AUTOPILOT_BUILD_STACK = "nextjs-supabase-tailwind" as const;
export type AutopilotBuildStack = typeof AUTOPILOT_BUILD_STACK;

export const REFERENCE_IMAGES_INSTRUCTION =
  "These reference image URLs are signed links that expire 7 days after upload. Open them for guidance, but never hotlink them: no signed URL may appear in the site's code, CSS, content or metadata. If the site uses one of these images, download it into the repo (for example `curl -fsSL \"<url>\" -o public/reference/<name>.jpg`) during codegen and reference the local copy (`/reference/<name>.jpg`). A spec that lists them must pass this rule on to codegen.";

export const PROVISION_GATE_SLUG = "" as const;

export const DEPLOY_GATE_SLUG = "" as const;

export const PREVIEW_GATE_SLUG = "" as const;

export type PipelineStage =
  | "repo_analysis"
  | "provision"
  | "spec"
  | "scaffold"
  | "preview"
  | "build"
  | "qa"
  | "deploy";
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "repo_analysis",
  "provision",
  "spec",
  "scaffold",
  "build",
  "qa",
  "deploy",
] as const;

export type AgentDispatchStage = Exclude<
  PipelineStage,
  "deploy" | "preview" | "repo_analysis"
>;

export const AGENT_DISPATCH_STAGES: readonly AgentDispatchStage[] = [
  "provision",
  "spec",
  "scaffold",
  "build",
  "qa",
] as const;

export const STAGE_AGENT: Record<PipelineStage, string> = {
  repo_analysis: "engineer",
  provision: PROVISION_GATE_SLUG,
  spec: "pm",
  scaffold: "engineer",
  preview: PREVIEW_GATE_SLUG,
  build: "engineer",
  qa: "qa",
  deploy: DEPLOY_GATE_SLUG,
};

export type BuildProductInput = {
  tenant_id: string;
  company_name: string;
  idea: string;
  reference_images?: string[];
  max_usd?: number | null;
};

export type ProvisionedTarget = {
  repo_url?: string;
  github_full_name?: string;
  default_branch?: string;
  neon_project_id?: string;
  github_target_mode?: "umbrella" | "user_repo";
};

export type RepoAnalysisPayload = {
  stage: "repo_analysis";
  idea: string;
  company_name: string;
  target: ProvisionedTarget;
  existing_repo: true;
};
export type ProvisionPayload = {
  stage: "provision";
  company_name: string;
  stack: AutopilotBuildStack;
  dry_run: boolean;
};
export type ArchetypeHintRef = {
  slug: string;
  classified: string;
  title: string;
  score: number;
  usedFallback: boolean;
  pages: string[];
  components: string[];
  tables: string[];
  visualMood: string;
};

export type SpecPayload = {
  stage: "spec";
  idea: string;
  archetype?: ArchetypeHintRef;
  reference_images?: string[];
  reference_images_instruction?: string;
  target?: ProvisionedTarget;
};
export type ScaffoldPayload = {
  stage: "scaffold";
  stack: AutopilotBuildStack;
  idea: string;
  company_name: string;
  archetype?: ArchetypeHintRef;
  reference_images?: string[];
  reference_images_instruction?: string;
  target?: ProvisionedTarget;
};
export type BuildPayload = {
  stage: "build";
  stack: AutopilotBuildStack;
  idea: string;
  company_name: string;
  prd?: string;
  reference_images?: string[];
  reference_images_instruction?: string;
  target?: ProvisionedTarget;
};
export type QaPayload = { stage: "qa"; target?: ProvisionedTarget };
export type PreviewPayload = { stage: "preview"; placeholder: true };
export type DeployPayload = { stage: "deploy" };
export type PipelinePayload =
  | RepoAnalysisPayload
  | ProvisionPayload
  | SpecPayload
  | ScaffoldPayload
  | PreviewPayload
  | BuildPayload
  | QaPayload
  | DeployPayload;

export type BuildProductGraph = ConductorNode[];

export const DECISION_CLASS = {
  PROVISION_REPO: "provision.repo",
  PROVISION_HOSTING: "provision.hosting",
  PROVISION_DOMAIN: "provision.domain",
  PROVISION_EMAIL: "provision.email",
  STRIPE_CREATE_CONNECTED_ACCOUNT: "stripe.create_connected_account",
  STRIPE_CHECKOUT: "stripe.checkout",
} as const;
export type DecisionClassSlug = (typeof DECISION_CLASS)[keyof typeof DECISION_CLASS];
