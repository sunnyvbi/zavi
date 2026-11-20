
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";
import {
  researchReportEnvelopeSchema,
  type ResearchReport,
} from "@/agents/research/output-schema";
import { groundResearchClaims } from "@/agents/research/claim-grounding";
import { renderResearchReportMarkdown } from "@/agents/research/render-markdown";
import { extractFirstJsonObject } from "./rubric";
import type { ResearchEvalTask } from "./types";

const RESEARCH_AGENT_MD = path.resolve(__dirname, "../../../agents/research/agent.md");

const DRIVER_MODEL = "claude-opus-4-7";

const EVAL_STALENESS_MONTHS = 24;

const DRIVER_HARNESS_NOTE = `
====================  EVAL HARNESS NOTE  ====================
You are running inside a local research-quality eval. Use the WebSearch and
WebFetch tools to research the ask. When done, emit your final answer as a SINGLE
<research_report>...</research_report> block whose body is the JSON envelope
described in your output contract — nothing after it. Do NOT write prose outside
the envelope; the envelope IS the deliverable.
============================================================
`;

type CapturedToolCall = { name: string; output_preview: string; input_preview?: string };

export type ResearchDriveResult = {
  task_id: string;
  rendered: string;
  error?: string;
};

export function buildResearchSystemPrompt(): string {
  let body = "";
  try {
    const raw = fs.readFileSync(RESEARCH_AGENT_MD, "utf-8");
    body = matter(raw).content.trim();
  } catch {
    body =
      "You are a senior research analyst. Produce a source-cited, structured research_report with validation tiers.";
  }
  return `${body}\n\n${DRIVER_HARNESS_NOTE}`;
}

function toPreview(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function extractEnvelopeJson(transcript: string): string | null {
  const tagged = transcript.match(/<research_report>([\s\S]*?)<\/research_report>/i);
  if (tagged) {
    const inner = extractFirstJsonObject(tagged[1]);
    if (inner) return inner;
  }
  return extractFirstJsonObject(transcript);
}

export async function driveResearchRun(task: ResearchEvalTask): Promise<ResearchDriveResult> {
  const systemPrompt = buildResearchSystemPrompt();
  const userPrompt = `OPERATOR ASK (${task.task_id}):\n\n${task.ask}\n\nResearch this and emit your <research_report> envelope.`;

  let transcript = "";
  const toolCalls: CapturedToolCall[] = [];
  const pendingByUseId = new Map<string, CapturedToolCall>();

  try {
    const stream = query({
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: userPrompt },
          parent_tool_use_id: null,
          session_id: `rq-${task.task_id}`,
        };
      })(),
      options: withAgentSdkIsolation({
        systemPrompt,
        model: DRIVER_MODEL,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        allowedTools: ["WebSearch", "WebFetch"],
        maxTurns: 30,
      }),
    });

    for await (const msg of stream) {
      const m = msg as {
        type?: string;
        message?: { content?: unknown };
      };
      if (m.type !== "assistant" && m.type !== "user") continue;
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const blk of content as Array<Record<string, unknown>>) {
        const btype = blk.type as string | undefined;
        if (btype === "text" && typeof blk.text === "string") {
          transcript += `${blk.text}\n`;
        } else if (btype === "tool_use") {
          const call: CapturedToolCall = {
            name: String(blk.name ?? "tool"),
            output_preview: "",
            input_preview: toPreview(blk.input),
          };
          toolCalls.push(call);
          if (typeof blk.id === "string") pendingByUseId.set(blk.id, call);
        } else if (btype === "tool_result") {
          const useId = typeof blk.tool_use_id === "string" ? blk.tool_use_id : undefined;
          const target = useId ? pendingByUseId.get(useId) : undefined;
          const preview = toPreview(blk.content);
          if (target) target.output_preview = preview;
        }
      }
    }
  } catch (e) {
    return { task_id: task.task_id, rendered: "", error: `research SDK error: ${(e as Error).message}` };
  }

  const envelopeJson = extractEnvelopeJson(transcript);
  if (!envelopeJson) {
    return { task_id: task.task_id, rendered: "", error: "no <research_report> envelope in transcript" };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(envelopeJson);
  } catch (e) {
    return { task_id: task.task_id, rendered: "", error: `envelope JSON parse failed: ${(e as Error).message}` };
  }

  const parsed = researchReportEnvelopeSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return {
      task_id: task.task_id,
      rendered: "",
      error: `envelope schema mismatch: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  if (parsed.data.kind !== "report") {
    return { task_id: task.task_id, rendered: "", error: "agent returned a clarification, not a report" };
  }

  let report: ResearchReport = parsed.data;
  try {
    const g = await groundResearchClaims(report, toolCalls, {
      stalenessMonths: EVAL_STALENESS_MONTHS,
      now: new Date(),
    });
    report = g.report;
  } catch {
    report = parsed.data;
  }

  const rendered = renderResearchReportMarkdown(report);
  return { task_id: task.task_id, rendered };
}

export function researchDriverPreflight(): { ok: boolean; reason?: string } {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      ok: false,
      reason:
        "No Anthropic auth: set ANTHROPIC_API_KEY (metered) or CLAUDE_CODE_OAUTH_TOKEN (subscription) to drive live research runs",
    };
  }
  const node = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (node.status !== 0) return { ok: false, reason: "node not available on PATH" };
  return { ok: true };
}
