
import { isConnectorRequestEnabled } from "./_chat-degrade-flag-check";
import { firstMissingChatConnector, probeSetupCompleteness } from "./setup-schema";
import { resolveCtoChatIntent } from "@/agents/engineer/intent";
import { repoHintOf } from "./zavi-built-repo";

type GateAgent = {
  slug: string;
  metadata_praxis: { setup?: { chat_requires_connect?: boolean } | null };
};

function isProvisionedBuildNode(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; target?: { github_full_name?: unknown } | null };
  return (
    process.env.PRODUCT_BUILDER_ENABLED !== "0" &&
    (p.stage === "scaffold" || p.stage === "build") &&
    typeof p.target?.github_full_name === "string" &&
    p.target.github_full_name.length > 0
  );
}

const MUTATION_VERB_RE =
  /\b(mak|made|chang|updat|add|remov|delet|fix|edit|replac|renam|mov|build|built|creat|ship|deploy|set|turn|redesign|rewrit|rewrote)\w*/i;

export function isInfoAsk(payload: unknown, text?: string): boolean {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const t = typeof text === "string" ? text : typeof p.task_description === "string" ? p.task_description : "";
  if (t.trim().length === 0) return p.cto_chat_intent === "info";
  return resolveCtoChatIntent(t) === "info" && !MUTATION_VERB_RE.test(t);
}

export async function connectGateSlugFor(args: {
  tenant_id: string;
  agent: GateAgent;
  trigger: string;
  payload?: unknown;
  text?: string;
}): Promise<string | null> {
  try {
    if (args.agent.metadata_praxis.setup?.chat_requires_connect !== true) return null;
    if (args.trigger !== "chat" && args.trigger !== "slack") return null;
    if (isProvisionedBuildNode(args.payload)) return null;
    if (isInfoAsk(args.payload, args.text)) return null;
    if (!(await isConnectorRequestEnabled())) return null;
    const probe = await probeSetupCompleteness(args.tenant_id, args.agent.slug);
    return await firstMissingChatConnector(args.tenant_id, args.agent.slug, probe, repoHintOf(args.payload));
  } catch {
    return null;
  }
}
