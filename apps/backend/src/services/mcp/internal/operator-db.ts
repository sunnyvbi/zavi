
import type { McpCallResult, McpTool } from "../types";
import {
  operatorDbCatalogTool,
  queryUserTool,
  queryListingTool,
  queryRecentTransactionsTool,
  operatorDbQueryTool,
} from "@/services/tools/operator-db/tools";
import {
  queryBookingsByGeoCategoryTool,
  queryActiveSupplyByGeoCategoryTool,
  queryFunnelByGeoCategoryTool,
  queryVerifiedBookingsByCampaignTool,
  queryNewUsersTool,
  queryNewBookingsTool,
  operatorDbSummaryTool,
} from "@/services/tools/operator-db/aggregates";
import { collectAccessNotes, readDbGeneration, type AccessNote } from "@/services/data-gateway";
import { codeactTool } from "./codeact-tool";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { logEvent } from "@/services/logging/logEvent";
import { getCatalogHash } from "@/services/tools/operator-db/mapping";
import {
  catalogInputKey,
  dropRunCatalogCache,
  getCachedCatalog,
  putCachedCatalog,
} from "@/services/tools/operator-db/catalog-run-cache";

const TOOLS = [
  operatorDbCatalogTool,
  queryUserTool,
  queryListingTool,
  queryRecentTransactionsTool,
  queryBookingsByGeoCategoryTool,
  queryActiveSupplyByGeoCategoryTool,
  queryFunnelByGeoCategoryTool,
  queryVerifiedBookingsByCampaignTool,
  queryNewUsersTool,
  queryNewBookingsTool,
  operatorDbQueryTool,
  codeactTool,
  operatorDbSummaryTool,
];

export function listOperatorDbTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^operator_db_/, "");
    return {
      server_id: "operator_db",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callOperatorDbTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  opts: { writes_suppressed?: boolean; run_id?: string | null; agent_slug?: string | null } = {},
): Promise<McpCallResult> {
  const start = Date.now();
  const runId = opts.run_id ?? null;
  if (tool_name === "catalog" && runId) {
    const cachedCall = await callCatalogCached(tenant_id, runId, args, opts, start);
    if (cachedCall) return cachedCall;
  }
  const result = await callOperatorDbToolUncached(tenant_id, tool_name, args, opts, start).catch((e: unknown) => {
    if (runId) dropRunCatalogCache(tenant_id, runId);
    throw e;
  });
  if (result.is_error && runId) dropRunCatalogCache(tenant_id, runId);
  return result;
}

async function callCatalogCached(
  tenant_id: string,
  runId: string,
  args: unknown,
  opts: { writes_suppressed?: boolean; run_id?: string | null; agent_slug?: string | null },
  start: number,
): Promise<McpCallResult | null> {
  const parsed = operatorDbCatalogTool.input_schema.safeParse(args);
  if (!parsed.success) return null;
  const [generation, hash] = await Promise.all([
    readDbGeneration(tenant_id).catch(() => null),
    getCatalogHash(tenant_id).catch(() => null),
  ]);
  if (generation === null || hash === null) return null;
  const fence = `${generation}:${hash}`;
  const key = catalogInputKey(parsed.data as { tables?: string[] });
  const cached = getCachedCatalog(tenant_id, runId, key, fence);
  if (cached) {
    const hit = await cached;
    return { ok: hit.ok, is_error: hit.is_error, content: hit.content, ms: Date.now() - start };
  }
  const result = callOperatorDbToolUncached(tenant_id, "catalog", args, opts, start);
  putCachedCatalog(tenant_id, runId, key, fence, result);
  return result.catch((e: unknown) => {
    dropRunCatalogCache(tenant_id, runId);
    throw e;
  });
}

async function callOperatorDbToolUncached(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  opts: { writes_suppressed?: boolean; run_id?: string | null; agent_slug?: string | null },
  start: number,
): Promise<McpCallResult> {
  const legacyName = `operator_db_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `operator_db/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const ctx = {
      tenant_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/operator_db/${tool_name}] ${msg}`, meta ?? "");
      },
      ...(opts.writes_suppressed ? { writes_suppressed: true } : {}),
      ...(opts.run_id ? { run_id: opts.run_id } : {}),
      ...(opts.agent_slug ? { agent_slug: opts.agent_slug } : {}),
      gateway: {
        tenant_id,
        caller: { kind: "agent" as const, agent_slug: opts.agent_slug ?? null, run_id: opts.run_id ?? null, tool_name: `operator_db__${tool_name}` },
      },
    };
    const { result: output, notes } = await collectAccessNotes(() => spec.execute(ctx, parsedInput));
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
      ...(notes.length ? { access_notes: notes } : {}),
    };
  } catch (e) {
    const ms = Date.now() - start;
    const access_notes = (e as { access_notes?: AccessNote[] } | null)?.access_notes;
    if (e instanceof ExpectedToolError) {
      await logEvent({
        level: "warn",
        source: "operator_db",
        code: e.code,
        error: e,
        tenant_id,
        meta: { tool_name, error_class: "ExpectedToolError", ms },
      });
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: e.code, message: e.message, ...(e.meta ? { meta: e.meta } : {}) }),
        ms: Date.now() - start,
        ...(access_notes?.length ? { access_notes } : {}),
      };
    }
    if ((e as { name?: string })?.name === "ZodError") {
      await logEvent({
        level: "warn",
        source: "operator_db",
        code: "operator_db_tool_input_invalid",
        tenant_id,
        meta: { tool_name, error_class: "ZodError", ms },
      });
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "tool_input_invalid",
          message: (e as Error).message,
        }),
        ms,
      };
    }
    const errClass = e instanceof Error ? e.constructor.name : typeof e;
    const driverCode = (e as { code?: unknown }).code;
    await logEvent({
      level: "error",
      source: "operator_db",
      code: "operator_db_tool_failed",
      tenant_id,
      meta: {
        tool_name,
        error_class: errClass,
        ms,
        ...(typeof driverCode === "number" || typeof driverCode === "string"
          ? { db_error_code: driverCode }
          : {}),
      },
    });
    throw e;
  }
}
