
import { callModel } from "@/services/llm/call-model";
import { MODELS, DEFAULT_PROVIDER } from "@/services/llm/models";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";

const MAX_TOKENS = 800;

const BUILD_SYSTEM =
  "You are a senior engineer planning a web app an AI team is about to build. " +
  "Given the operator's idea, write a SHORT, concrete implementation plan in markdown with EXACTLY these sections:\n" +
  "## Approach\n(1-2 sentences on the overall shape)\n" +
  "## Key features\n(3-6 bullets)\n" +
  "## Pages & screens\n(bullets)\n" +
  "## Data model\n(bullets: the main entities + key fields)\n" +
  "Be specific to THIS product. No preamble, no closing remarks — just the markdown.";

const REFINE_SYSTEM =
  "You are a senior engineer planning a change to an existing web app an AI team maintains. " +
  "Given the requested change, write a SHORT markdown plan with EXACTLY these sections:\n" +
  "## Approach\n(1-2 sentences)\n" +
  "## What changes\n(bullets: the components/behavior/files that change)\n" +
  "## Risks\n(1-3 bullets of what to watch for)\n" +
  "Be specific and concrete. No preamble, no closing remarks — just the markdown.";

export async function generateBuildPlan(args: {
  idea: string;
  mode: "build" | "refine";
  appContext?: string | null;
}): Promise<string> {
  const idea = args.idea.trim();
  const system = args.mode === "refine" ? REFINE_SYSTEM : BUILD_SYSTEM;
  const label = args.mode === "refine" ? "Requested change" : "App idea";
  const appBlock = args.mode === "refine" && args.appContext ? renderUntrustedBlock("current_app", args.appContext) : "";
  const context = appBlock ? `The app as built today (an excerpt of its routes and main pages):\n${appBlock}\n\n` : "";
  const resp = await callModel({
    provider: DEFAULT_PROVIDER,
    model: MODELS.anthropic.haiku,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: `${context}${label}:\n${idea}` }],
  });
  const text = (resp.text ?? "").trim();
  if (!text) throw new Error("empty plan");
  return text;
}
