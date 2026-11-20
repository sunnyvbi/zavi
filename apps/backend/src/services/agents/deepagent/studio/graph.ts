
import type { AgentEngineRunSpec } from "../../engine/types";
import { buildDeepAgent } from "../engine";
import {
  deepAgentDefaultLangChainModelId,
  resolveDeepAgentModel,
} from "../resolve-model";
import { resolveDeepAgentProfile } from "../resolve-profile";
import { makeStudioDispatchTool, STUDIO_TOOLS, type StudioToolLog } from "./local-funnel";

export const STUDIO_DEFAULT_MODEL = deepAgentDefaultLangChainModelId();

export const studioToolLog: StudioToolLog[] = [];

async function studioSpec(): Promise<AgentEngineRunSpec> {
  const tenantId = process.env.ZAVI_STUDIO_TENANT_ID?.trim() || undefined;

  let tools = STUDIO_TOOLS;
  let dispatchTool = makeStudioDispatchTool(studioToolLog);

  if (tenantId) {
    const { buildRealStudioTools, makeRealStudioDispatchTool, STUDIO_AGENT_SLUG } =
      await import("./real-funnel");
    tools = await buildRealStudioTools(tenantId);
    dispatchTool = makeRealStudioDispatchTool({ tenantId }) as typeof dispatchTool;
    console.log(
      `[studio] LIVE MODE — tenant ${tenantId}, agent ${STUDIO_AGENT_SLUG}, ` +
        `${tools.length} real tools, writes ${
          process.env.ZAVI_STUDIO_ALLOW_WRITES === "1" ? "ENABLED ⚠️" : "denied"
        }`,
    );
  } else {
    console.log(`[studio] FIXTURE MODE — ${tools.length} fake tools, nothing touches production`);
  }

  return {
    systemPrompt: "",
    userPrompt: "",
    model: "unused-studio-supplies-resolved-id",
    maxTurns: Number(process.env.ZAVI_STUDIO_MAX_TURNS ?? 40),
    tools,
    resume: null,
    abort: new AbortController(),
    dispatchTool,
    onEvent: () => {},
    tenantId,
    runId: "studio-local",
  } as AgentEngineRunSpec;
}

let cached: ReturnType<typeof buildStudioGraph> | undefined;

async function buildStudioGraph() {
  const model = resolveDeepAgentModel(
    process.env.ZAVI_STUDIO_MODEL || STUDIO_DEFAULT_MODEL,
  );
  const profile = resolveDeepAgentProfile(model);
  console.log(`[studio] prompt profile: ${profile.id} (${profile.label})`);

  return buildDeepAgent(await studioSpec(), {
    model,
    mountMemory: Boolean(process.env.ZAVI_STUDIO_TENANT_ID),
    verifiers: [
      {
        id: "studio-source-citation",
        check: (text: string) => {
          const hasNumber = /\b\d[\d,.]*\s*(%|usd|\$|rentals|bookings|clicks)?/i.test(text);
          const citesTool = /meta_ads__|operator_db__|memory__|\/scratch\//.test(text);
          if (hasNumber && !citesTool && text.length > 200) {
            return "You stated figures without naming the tool result they came from. Name the source for each, or remove the figure.";
          }
          return null;
        },
      },
      {
        id: "studio-proposal-not-done",
        check: (text: string) => {
          if (/\b(I have (updated|paused|changed|posted)|I've (updated|paused|changed|posted))\b/i.test(text)) {
            return "You described a change as already made. Nothing was executed — every write in this session is a proposal. Restate it as a proposal.";
          }
          return null;
        },
      },
    ],
  });
}

export function graph() {
  cached ??= buildStudioGraph();
  return cached;
}
