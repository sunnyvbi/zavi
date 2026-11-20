
export type DeepAgentProfileId =
  | "codex"
  | "claude"
  | "fireworks-kimi"
  | "fireworks-glm"
  | "default";

export type SubagentPromptDef = {
  description: string;
  systemPrompt: string;
};

export type DeepAgentPromptProfile = {
  id: DeepAgentProfileId;
  label: string;
  harnessOverlay: string;
  modelAddendum?: string;
  subagents: {
    researcher: SubagentPromptDef;
    "data-reconciler": SubagentPromptDef;
    "creative-analyst": SubagentPromptDef;
    "campaign-drafter": SubagentPromptDef;
  };
};

export const PROFILE_HEADER =
  "## DEEPAGENT HARNESS (model profile — sharpens tool/skills/subagent behavior)";

export const MODEL_ADDENDUM_HEADER =
  "## MODEL PROFILE (provider-specific — overrides nothing above)";
