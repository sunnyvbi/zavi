
import type { SubAgent } from "deepagents";
import type { AgentEngineRunSpec } from "../engine/types";
import { toLangChainModelId } from "./model-id";
import type { DeepAgentPromptProfile } from "./profiles/types";
import { deepAgentModelId, resolveDeepAgentModel, type DeepAgentModel } from "./resolve-model";
import { resolveDeepAgentProfile } from "./resolve-profile";
import { buildLangChainTools, readOnlyToolSpecs, wrapAsLangChainTool } from "./tool-bridge";

function subagentModel() {
  const raw = process.env.DEEPAGENT_SUBAGENT_MODEL?.trim();
  if (!raw) return undefined;
  const id = raw.includes(":") ? raw : toLangChainModelId(raw);
  return resolveDeepAgentModel(id);
}

function readOnlyTools(spec: AgentEngineRunSpec) {
  return readOnlyToolSpecs(spec.tools).map((t) => wrapAsLangChainTool(t, spec));
}

function subagentFromProfile(
  name: keyof DeepAgentPromptProfile["subagents"],
  def: DeepAgentPromptProfile["subagents"][keyof DeepAgentPromptProfile["subagents"]],
  ro: ReturnType<typeof readOnlyTools>,
  subModelOpt: { model?: DeepAgentModel } | Record<string, never>,
  tools: SubAgent["tools"],
): SubAgent {
  return {
    name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools,
    ...subModelOpt,
  };
}

export function buildSubagents(
  spec: AgentEngineRunSpec,
  profile?: DeepAgentPromptProfile,
): SubAgent[] {
  const ro = readOnlyTools(spec);
  const subModel = subagentModel();
  const subModelOpt = subModel ? { model: subModel } : {};
  const p =
    profile ??
    resolveDeepAgentProfile(
      subModel ?? resolveDeepAgentModel(deepAgentModelId(spec.model)),
    );

  const researcher = subagentFromProfile("researcher", p.subagents.researcher, ro, subModelOpt, ro);
  const dataReconciler = subagentFromProfile(
    "data-reconciler",
    p.subagents["data-reconciler"],
    ro,
    subModelOpt,
    ro,
  );
  const creativeAnalyst = subagentFromProfile(
    "creative-analyst",
    p.subagents["creative-analyst"],
    ro,
    subModelOpt,
    ro,
  );
  const campaignDrafter = subagentFromProfile(
    "campaign-drafter",
    p.subagents["campaign-drafter"],
    ro,
    subModelOpt,
    [],
  );

  return [researcher, dataReconciler, creativeAnalyst, campaignDrafter];
}

export function subagentToolNames(spec: AgentEngineRunSpec): Record<string, string[]> {
  const all = buildLangChainTools(spec).map((t) => t.name);
  void all;
  return Object.fromEntries(
    buildSubagents(spec).map((s) => [
      s.name,
      ((s.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
    ]),
  );
}
