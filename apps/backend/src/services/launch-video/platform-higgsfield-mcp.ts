
import {
  HIGGSFIELD_MCP_URL,
  getPlatformAccessToken,
  invalidatePlatformAccessToken,
  isPlatformMcpConfigured,
} from "@/services/connectors/higgsfield/token-provider";
import type { GenerationFailureReason } from "./platform-higgsfield";

export { isPlatformMcpConfigured };

export const DEFAULT_IMAGE_MODEL = "gpt_image_2_5";

const CALL_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 240_000;
const FAILED_FOR_GOOD = new Set(["failed", "error", "nsfw", "cancelled", "canceled", "rejected"]);
const DEFAULT_POLL_WAIT_MS = 3_000;

export type McpGenOk = {
  ok: true;
  url: string;
  jobId: string;
  credits?: number;
};
export type McpGenErr = {
  ok: false;
  error: string;
  reason?: GenerationFailureReason;
};

function parseSseFrames(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
    }
  }
  return out;
}

function classify(status: number, body: string): GenerationFailureReason {
  if (/not_enough_credits|insufficient_credit/i.test(body || "")) return "vendor_wallet_exhausted";
  if (status === 401 || status === 403) return "credential_rejected";
  return "vendor_error";
}

type ToolCallResult =
  | { ok: true; structured: Record<string, unknown>; text: string }
  | { ok: false; error: string; reason?: GenerationFailureReason };

async function callTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolCallResult> {
  let res!: Response;
  let body = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getPlatformAccessToken();
    } catch (e) {
      return { ok: false, error: `higgsfield token unavailable: ${(e as Error).message}`, reason: "credential_rejected" };
    }

    try {
      res = await fetch(HIGGSFIELD_MCP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (e) {
      return { ok: false, error: `mcp ${name} transport: ${(e as Error).message}`, reason: "vendor_error" };
    }

    if (res.status !== 401) break;
    invalidatePlatformAccessToken(token);
  }

  if (!res.ok) {
    return { ok: false, error: `mcp ${name} ${res.status}: ${body.slice(0, 240)}`, reason: classify(res.status, body) };
  }

  const frames = parseSseFrames(body);
  if (frames.length === 0) {
    return { ok: false, error: `mcp ${name}: no JSON-RPC frame in response`, reason: "vendor_error" };
  }

  for (const f of frames) {
    const err = f.error as { message?: string } | undefined;
    if (err) {
      const msg = err.message || JSON.stringify(err);
      return { ok: false, error: `mcp ${name}: ${msg.slice(0, 240)}`, reason: classify(200, msg) };
    }
  }

  const result = (frames.find((f) => f.result)?.result ?? {}) as Record<string, unknown>;
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
  const text = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");

  if (result.isError === true) {
    return { ok: false, error: `mcp ${name}: ${text.slice(0, 240)}`, reason: classify(200, text) };
  }

  return { ok: true, structured: (result.structuredContent ?? {}) as Record<string, unknown>, text };
}

export type McpImageParams = {
  prompt: string;
  aspect_ratio?: string;
  model?: string;
};

function resultUrlFrom(structured: Record<string, unknown>): string | undefined {
  const gen = structured.generation as
    | { status?: string; results?: { rawUrl?: string; minUrl?: string } }
    | undefined;
  const url = gen?.results?.rawUrl || gen?.results?.minUrl;
  return typeof url === "string" && url.startsWith("https://") ? url : undefined;
}

export async function generateMcpImage(params: McpImageParams): Promise<McpGenOk | McpGenErr> {
  if (!(await isPlatformMcpConfigured())) {
    return { ok: false, error: "higgsfield MCP platform credential not configured", reason: "credential_rejected" };
  }

  const submitted = await callTool(
    "generate_image",
    {
      params: {
        model: params.model ?? DEFAULT_IMAGE_MODEL,
        prompt: params.prompt,
        aspect_ratio: params.aspect_ratio ?? "1:1",
      },
    },
    CALL_TIMEOUT_MS,
  );
  if (!submitted.ok) return submitted;

  const results = (submitted.structured as { results?: Array<{ id?: string }> }).results;
  const jobId = Array.isArray(results) ? results[0]?.id : undefined;
  if (!jobId) {
    return { ok: false, error: "mcp generate_image: submitted but no job id returned", reason: "vendor_error" };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: `mcp job ${jobId} still running after ${POLL_TIMEOUT_MS / 1000}s`, reason: "vendor_error" };
    }
    const done = await callTool("job_status", { jobId, sync: true }, remaining);
    if (!done.ok) return { ...done, error: `${done.error} (job ${jobId})` };

    const url = resultUrlFrom(done.structured);
    if (url) return { ok: true, url, jobId };

    const status = String(
      (done.structured.generation as { status?: string } | undefined)?.status ?? "unknown",
    ).toLowerCase();
    if (FAILED_FOR_GOOD.has(status) || status === "completed") {
      return { ok: false, error: `mcp job ${jobId} ended '${status}' with no result url`, reason: "vendor_error" };
    }

    const hinted = Number(done.structured.poll_after_seconds);
    const waitMs = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, 30) * 1000 : DEFAULT_POLL_WAIT_MS;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
  }
}
