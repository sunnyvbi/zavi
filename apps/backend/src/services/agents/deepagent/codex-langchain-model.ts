
import { ChatOpenAI } from "@langchain/openai";
import {
  applyCodexBodyQuirks,
  assertUnderWeeklyCap,
  isCodexEnabled,
} from "@/services/codex-subscription";
import { MODELS } from "@/services/llm/models";

export const DEEPAGENT_CODEX_MODEL = MODELS.openai.flagship;

const codexFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  if (init?.body && typeof init.body === "string") {
    init = { ...init, body: applyCodexBodyQuirks(init.body) };
  }
  return fetch(input, init).then(async (res) => {
    assertUnderWeeklyCap(res.headers);
    return res;
  });
}) as typeof fetch;

export function bareOpenAiModelId(langChainModelId: string): string {
  const m = langChainModelId.trim();
  return m.startsWith("openai:") ? m.slice("openai:".length) : m;
}

export function buildCodexChatModel(modelId?: string): ChatOpenAI | null {
  if (!isCodexEnabled()) return null;
  const apiKey = process.env.CODEX_ACCESS_TOKEN;
  if (!apiKey) return null;

  const model =
    (modelId ?? process.env.DEEPAGENT_CODEX_MODEL ?? DEEPAGENT_CODEX_MODEL).trim() ||
    DEEPAGENT_CODEX_MODEL;

  return new ChatOpenAI({
    model: bareOpenAiModelId(model),
    apiKey,
    streaming: true,
    useResponsesApi: true,
    zdrEnabled: true,
    configuration: {
      baseURL:
        process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
      defaultHeaders: {
        "chatgpt-account-id": process.env.CODEX_ACCOUNT_ID ?? "",
        originator: "codex_cli_rs",
        "OpenAI-Beta": "responses=experimental",
      },
      fetch: codexFetch,
    },
  });
}
