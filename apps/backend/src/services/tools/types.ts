
import type { ZodTypeAny } from "zod";
import { CONNECTOR_CONNECT, connectInfoFor } from "@zavi/shared";
import { isGuardRefusal } from "./guard-refusal";

export type ToolContext = {
  tenant_id: string;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  run_id?: string;
  agent_slug?: string;
  actor?: import("@/services/agents/actor-envelope").ActorAuthorityEnvelopeV1;
  run_trigger?: string;
  gateway?: import("@/services/data-gateway/types").GatewayContext;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
  rules_steered?: { budget: boolean; status: boolean };
  slack_team_id?: string;
  chat_thread_id?: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  writes_suppressed?: boolean;
  chat_answer_turn?: boolean;
};

export type ToolEffect = "read" | "write" | "money" | "destructive";

export type ToolSpec<I = unknown, O = unknown> = {
  name: string;
  description: string;
  input_schema: ZodTypeAny;
  effect: ToolEffect;
  execute: (ctx: ToolContext, input: I) => Promise<O>;
};

export class ExpectedToolError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ExpectedToolError";
  }
}

export type ToolCallStatus = "ok" | "tool_error" | "throw";

export type ToolCallTrace = {
  name: string;
  input_preview: string;
  output_preview: string;
  ms: number;
  status: ToolCallStatus;
  code?: string;
  connector_slug?: string;
  connector_mode?: "connect" | "reconnect";
  returned_ids?: string[];
  tool_use_id?: string;
  receipts?: ToolReceipt[];
  test_receipt?: import("@/agents/engineer/engineer-verify-receipt").VerifyReceipt | null;
  typecheck_receipt?: import("@/agents/engineer/typecheck-receipt").TypecheckReceipt | null;
  result_truncated?: boolean;

  result_had_totals?: boolean;
};

export type ToolReceipt = {
  type: string;
  label: string;
  url?: string;
};

export const INPUT_PREVIEW_BYTES = 2 * 1024;
export const OUTPUT_PREVIEW_BYTES = 8 * 1024;
export const LAB_OUTPUT_PREVIEW_BYTES = 1024 * 1024;
export const RETURNED_IDS_CAP = 300;

export function unescapeJsonPreview(s: string): string {
  return s.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function previewJson(value: unknown, capBytes: number): string {
  const json = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  if (json.length <= capBytes) return json;
  const truncatedBytes = json.length - capBytes;
  return `${json.slice(0, capBytes)}…[truncated ${truncatedBytes} bytes]`;
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function fillTraceFromToolResult(
  trace: Partial<
    Pick<
      ToolCallTrace,
      "output_preview" | "status" | "returned_ids" | "code" | "connector_slug" | "connector_mode"
    >
  >,
  block: { content?: unknown; is_error?: boolean },
  capBytes: number = OUTPUT_PREVIEW_BYTES,
): void {
  trace.output_preview = previewJson(block.content, capBytes);
  if (block.is_error) {
    trace.status = "tool_error";
    const conn = connectorErrorFromContent(block.content);
    if (conn) {
      trace.code = conn.code;
      trace.connector_slug = conn.connector_slug;
      if (conn.connector_mode) trace.connector_mode = conn.connector_mode;
    } else {
      const code = errorCodeFromContent(block.content);
      if (isGuardRefusal(code)) trace.code = code as string;
    }
    delete trace.returned_ids;
  } else {
    trace.returned_ids = extractReturnedIds(block.content);
  }
}

export function extractReturnedIds(value: unknown, cap = RETURNED_IDS_CAP): string[] | undefined {
  let json: string;
  try {
    json = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    json = String(value);
  }
  if (!json) return undefined;
  const seen = new Set<string>();
  for (const m of json.matchAll(UUID_RE)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= cap) break;
  }
  return seen.size > 0 ? [...seen] : undefined;
}

export const CONNECTOR_ERROR_SUFFIXES = {
  not_connected: "connect",
  auth_expired: "reconnect",
  reauth_required: "reconnect",
  token_expired: "reconnect",
  connection_stopped: "reconnect",
} as const;

const CODE_TO_CONNECTOR: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const slug of Object.keys(CONNECTOR_CONNECT)) {
    for (const suffix of Object.keys(CONNECTOR_ERROR_SUFFIXES)) m.set(`${slug}_${suffix}`, slug);
  }
  return m;
})();

export function connectorErrorMode(code: string | undefined): "connect" | "reconnect" | null {
  if (!code) return null;
  for (const [suffix, mode] of Object.entries(CONNECTOR_ERROR_SUFFIXES)) {
    if (code.endsWith(`_${suffix}`)) return mode;
  }
  return null;
}

export function connectorSlugForError(code: string, meta?: unknown): string | undefined {
  if (!connectorErrorMode(code)) return undefined;
  const named =
    meta && typeof meta === "object" ? (meta as { connector_slug?: unknown }).connector_slug : undefined;
  if (typeof named === "string" && connectInfoFor(named)) return named;
  return CODE_TO_CONNECTOR.get(code);
}

function errorEnvelopeFromContent(content: unknown): { code: string; meta: unknown } | null {
  const text = Array.isArray(content)
    ? content
        .map((b) =>
          b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .join("")
    : typeof content === "string"
      ? content
      : null;
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const code = (parsed as { error?: unknown }).error;
  if (typeof code !== "string") return null;
  return { code, meta: (parsed as { meta?: unknown }).meta };
}

export function errorCodeFromContent(content: unknown): string | null {
  return errorEnvelopeFromContent(content)?.code ?? null;
}

export function connectorErrorFromContent(
  content: unknown,
): { code: string; connector_slug: string; connector_mode?: "connect" | "reconnect" } | null {
  const env = errorEnvelopeFromContent(content);
  if (!env) return null;
  const { code, meta } = env;
  const slug = connectorSlugForError(code, meta);
  if (!slug) return null;
  const mode =
    meta && typeof meta === "object" ? (meta as { connector_mode?: unknown }).connector_mode : undefined;
  return mode === "connect" || mode === "reconnect"
    ? { code, connector_slug: slug, connector_mode: mode }
    : { code, connector_slug: slug };
}
