
import { readFile } from "node:fs/promises";
import path from "node:path";
import { initChatModel } from "langchain/chat_models/universal";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { listOperatorDbTools } from "@/services/mcp/internal/operator-db";
import { deepAgentModelId, resolveDeepAgentModel } from "@/services/agents/deepagent/resolve-model";
import { runTool } from "./eval-tenant";
import type { Dataset } from "../fixtures/types";

export const MAX_TOOL_ROUNDS = 16;

export type AgentTurn = {
  answer: string;
  toolCalls: { name: string; args: unknown; ok: boolean; error?: string }[];
  rounds: number;
  stoppedEarly: boolean;
};

let cachedSkill: string | null = null;

export async function operatorDbSkill(): Promise<string> {
  if (cachedSkill) return cachedSkill;
  const p =
    process.env.EVAL_OPDB_SKILL_PATH?.trim() ||
    path.resolve(process.cwd(), "src/agents/_core/connectors/operator_db/skill.md");
  const raw = await readFile(p, "utf8");
  cachedSkill = raw.replace(/^---[\s\S]*?---\n/, "");
  return cachedSkill;
}

export function systemPrompt(skill: string, dataset: Dataset): string {
  return [
    "You are the data analyst for this company. The operator asks you questions about their business and",
    "you answer them from their production database.",
    "",
    `THE BUSINESS: ${dataset.business}`,
    `TODAY IS ${dataset.anchorIso} (UTC). The operator's reporting timezone is ${dataset.timezone}.`,
    "",
    skill,
    "",
    "HOW TO ANSWER:",
    "- Do the work with the tools. Never guess a number, and never answer from the business description alone.",
    "- Finish with a single final message. If the answer is a number, put it on its own line at the very end in",
    "  the exact form `ANSWER: <number>` with no thousands separators, no currency symbol and no units;",
    "  percentages as the number out of 100 (e.g. `ANSWER: 12.5`). Say the units in the prose above it.",
    "- If the database genuinely cannot answer the question, end with `ANSWER: CANNOT_ANSWER` and say which",
    "  field is missing.",
  ].join("\n");
}

function acceptsTemperature(modelId: string): boolean {
  return !/(^|[:/-])(gpt-5|o1|o3|o4)/i.test(modelId);
}

async function buildModel(): Promise<BaseLanguageModel> {
  const id = process.env.EVAL_OPDB_MODEL?.trim() || deepAgentModelId();
  const resolved = resolveDeepAgentModel(id);
  if (typeof resolved !== "string") return resolved;
  const opts = acceptsTemperature(resolved) ? { temperature: 0 } : {};
  return (await initChatModel(resolved, opts)) as unknown as BaseLanguageModel;
}

export async function askAgent(question: string, dataset: Dataset): Promise<AgentTurn> {
  const model = await buildModel();
  const tools = listOperatorDbTools().map((t) => ({
    name: t.tool_name,
    description: t.description,
    schema: t.input_schema as never,
  }));
  const bound = (model as unknown as { bindTools: (t: unknown[]) => BaseLanguageModel }).bindTools(tools);

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt(await operatorDbSkill(), dataset)),
    new HumanMessage(question),
  ];
  const toolCalls: AgentTurn["toolCalls"] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = (await (bound as unknown as { invoke: (m: BaseMessage[]) => Promise<BaseMessage> }).invoke(
      messages,
    )) as BaseMessage & { tool_calls?: { id?: string; name: string; args: unknown }[] };
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        answer: typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content),
        toolCalls,
        rounds: round + 1,
        stoppedEarly: false,
      };
    }

    for (const call of calls) {
      const res = await runTool(call.name, call.args);
      toolCalls.push({
        name: call.name,
        args: call.args,
        ok: res.ok,
        error: res.ok ? undefined : res.content.slice(0, 400),
      });
      messages.push(
        new ToolMessage({
          tool_call_id: call.id ?? `${call.name}-${toolCalls.length}`,
          content: res.content.slice(0, 40_000),
        }),
      );
    }
  }

  return { answer: "", toolCalls, rounds: MAX_TOOL_ROUNDS, stoppedEarly: true };
}
