
import type { Anthropic } from "@anthropic-ai/sdk";
import { callMcpTool, type CallMcpContext } from "@/services/mcp/execute";
import { listJiraTools } from "@/services/mcp/internal/jira";
import { listSlackTools } from "@/services/mcp/internal/slack";
import type { McpCallResult, McpTool } from "@/services/mcp/types";

const ALLOWED_TOOLS = new Set<string>([
  "jira.search",
  "jira.get_issue",
  "slack.read_thread",
]);

const RETRY_TIMEOUT_MS = 15_000;

export type TriageEventContext = {
  channel_id: string;
  thread_ts: string;
};

export type TriageToolName = "jira.search" | "jira.get_issue" | "slack.read_thread";

export function buildClassifierTools(): Anthropic.Tool[] {
  const jiraReads = listJiraTools().map((t) => ({ ...t, server_id: "jira" }));
  const slackAll = listSlackTools();
  const all: McpTool[] = [...jiraReads, ...slackAll];

  const out: Anthropic.Tool[] = [];
  for (const t of all) {
    const key = `${t.server_id}.${t.tool_name}`;
    if (!ALLOWED_TOOLS.has(key)) continue;

    let schema = t.input_schema;
    if (key === "slack.read_thread") {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      const { channel_id: _c, thread_ts: _t, ...rest } = props;
      schema = {
        type: "object",
        properties: rest,
        required: [],
      } as { type: "object"; [k: string]: unknown };
    }

    out.push({
      name: key.replace(".", "__"),
      description: t.description,
      input_schema: schema as Anthropic.Tool["input_schema"],
    });
  }
  return out;
}

export async function callClassifierTool(
  ctx: CallMcpContext,
  event: TriageEventContext,
  toolName: string,
  rawArgs: unknown,
): Promise<{ ok: boolean; shaped: unknown; is_error: boolean }> {
  const key = toolName.replace("__", ".");
  if (!ALLOWED_TOOLS.has(key)) {
    return {
      ok: false,
      is_error: true,
      shaped: { error: "tool_denied", message: `tool ${toolName} not in classifier allowlist` },
    };
  }

  const [server_id, tool_name] = key.split(".");
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  let finalArgs = args;
  if (key === "slack.read_thread") {
    finalArgs = {
      ...args,
      channel_id: event.channel_id,
      thread_ts: event.thread_ts,
    };
  }

  const result = await callWithRetry(ctx, server_id, tool_name, finalArgs);
  if (result.is_error) {
    return { ok: false, is_error: true, shaped: safeParse(result.content) };
  }

  const parsed = safeParse(result.content);
  const shaped = shapeOutput(key, parsed);
  return { ok: true, is_error: false, shaped };
}

async function callWithRetry(
  ctx: CallMcpContext,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const first = await withTimeout(callMcpTool(ctx, server_id, tool_name, args), RETRY_TIMEOUT_MS);
  if (!shouldRetry(first)) return first;
  return withTimeout(callMcpTool(ctx, server_id, tool_name, args), RETRY_TIMEOUT_MS);
}

function shouldRetry(r: McpCallResult): boolean {
  if (!r.is_error) return false;
  const parsed = safeParse(r.content) as { error?: string };
  const code = parsed?.error ?? "";
  return (
    code === "timeout" ||
    code === "upstream_5xx" ||
    code === "rate_limited" ||
    code === "429"
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | McpCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<McpCallResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          is_error: true,
          content: JSON.stringify({ error: "timeout", message: `> ${ms}ms` }),
          ms,
        } satisfies McpCallResult),
      ms,
    );
  });
  try {
    return (await Promise.race([p, timeout])) as T | McpCallResult;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: String(s).slice(0, 200) };
  }
}

const MAX_TOTAL_BYTES = 4 * 1024;

type JiraSearchResp = {
  issues?: Array<{
    key?: string;
    fields?: {
      summary?: string;
      status?: { name?: string };
      assignee?: { displayName?: string };
    };
  }>;
  total?: number;
};

type JiraIssueResp = {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    description?: unknown;
  };
};

type SlackThreadResp = {
  messages?: Array<{ ts?: string; user?: string; text?: string }>;
};

function shapeOutput(key: string, raw: unknown): unknown {
  switch (key) {
    case "jira.search": {
      const r = (raw ?? {}) as JiraSearchResp;
      const issues = (r.issues ?? []).slice(0, 10).map((i) => ({
        key: i.key ?? "",
        summary: trim(i.fields?.summary ?? "", 200),
        status: i.fields?.status?.name ?? "",
        assignee: i.fields?.assignee?.displayName ?? null,
      }));
      return capBytes({ total: r.total ?? issues.length, issues });
    }
    case "jira.get_issue": {
      const r = (raw ?? {}) as JiraIssueResp;
      return capBytes({
        key: r.key ?? "",
        summary: trim(r.fields?.summary ?? "", 300),
        status: r.fields?.status?.name ?? "",
        description: trim(adfToPlain(r.fields?.description), 1024),
      });
    }
    case "slack.read_thread": {
      const r = (raw ?? {}) as SlackThreadResp;
      const messages = (r.messages ?? []).slice(0, 20).map((m) => ({
        ts: m.ts ?? "",
        user: m.user ?? "unknown",
        text: trim(m.text ?? "", 500),
      }));
      return capBytes({ messages });
    }
    default:
      return raw;
  }
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function capBytes<T>(obj: T): T {
  if (Buffer.byteLength(JSON.stringify(obj), "utf-8") <= MAX_TOTAL_BYTES) {
    return obj;
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = { ...obj } as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      while (
        Array.isArray(rec[k]) &&
        (rec[k] as unknown[]).length > 0 &&
        Buffer.byteLength(JSON.stringify(rec), "utf-8") > MAX_TOTAL_BYTES
      ) {
        (rec[k] as unknown[]).pop();
      }
    }
    rec._truncated = true;
    if (Buffer.byteLength(JSON.stringify(rec), "utf-8") <= MAX_TOTAL_BYTES) {
      return rec as T;
    }
  }
  return { _truncated: true, _reason: "exceeds_4kb_cap" } as unknown as T;
}

function adfToPlain(node: unknown): string {
  if (!node || typeof node !== "object") {
    return typeof node === "string" ? node : "";
  }
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map(adfToPlain).join(n.type === "paragraph" ? "" : "\n");
  }
  return "";
}

export const _internal = { ALLOWED_TOOLS, shapeOutput, MAX_TOTAL_BYTES };
