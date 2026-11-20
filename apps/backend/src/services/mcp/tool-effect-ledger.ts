
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import type { McpCallResult } from "./types";
import type { CallMcpContext } from "./execute";

export function isToolEffectLedgerEnabled(): boolean {
  return process.env.PRAXIS_TOOL_EFFECT_LEDGER === "1";
}

export function hashToolInput(args: unknown): string {
  let json: string;
  try {
    json = stableStringify(args);
  } catch {
    json = String(args);
  }
  return createHash("sha256").update(json).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export type CommittedEffect = { result: McpCallResult; input_hash: string | null };

export type ToolEffectDeps = {
  lookupCommitted: (run_id: string, tool_use_id: string) => Promise<CommittedEffect | McpCallResult | null>;
  claimPending: (input: {
    run_id: string;
    tenant_id: string;
    tool_use_id: string;
    iter: number | null;
    tool_name: string;
    input_hash: string;
    takeover?: boolean;
  }) => Promise<boolean | void | "stale">;
  commit: (run_id: string, tool_use_id: string, result: McpCallResult) => Promise<void>;
  release?: (run_id: string, tool_use_id: string) => Promise<void>;
};

export const PENDING_LEASE_MS = 15 * 60_000;

export const realToolEffectDeps: ToolEffectDeps = {
  async lookupCommitted(run_id, tool_use_id) {
    const { data, error } = await serviceClient()
      .from("agent_tool_effects")
      .select("result, input_hash")
      .eq("run_id", run_id)
      .eq("tool_use_id", tool_use_id)
      .eq("status", "committed")
      .maybeSingle();
    if (error) throw new Error(error.message);
    const stored = data?.result as McpCallResult | null | undefined;
    if (!stored) return null;
    return { result: stored, input_hash: (data?.input_hash as string | null | undefined) ?? null };
  },
  async claimPending(input) {
    const { data, error } = await serviceClient()
      .from("agent_tool_effects")
      .upsert(
        {
          run_id: input.run_id,
          tenant_id: input.tenant_id,
          tool_use_id: input.tool_use_id,
          iter: input.iter,
          tool_name: input.tool_name,
          input_hash: input.input_hash,
          status: "pending",
        },
        { onConflict: "run_id,tool_use_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) return true;
    if (input.takeover === false) {
      const { data: stale, error: staleErr } = await serviceClient()
        .from("agent_tool_effects")
        .select("id")
        .eq("run_id", input.run_id)
        .eq("tool_use_id", input.tool_use_id)
        .eq("status", "pending")
        .lt("created_at", new Date(Date.now() - PENDING_LEASE_MS).toISOString());
      if (staleErr) throw new Error(staleErr.message);
      return Array.isArray(stale) && stale.length > 0 ? "stale" : false;
    }
    const { data: taken, error: takeErr } = await serviceClient()
      .from("agent_tool_effects")
      .update({ created_at: new Date().toISOString(), input_hash: input.input_hash, tool_name: input.tool_name })
      .eq("run_id", input.run_id)
      .eq("tool_use_id", input.tool_use_id)
      .eq("status", "pending")
      .lt("created_at", new Date(Date.now() - PENDING_LEASE_MS).toISOString())
      .select("id");
    if (takeErr) throw new Error(takeErr.message);
    return Array.isArray(taken) && taken.length > 0;
  },
  async commit(run_id, tool_use_id, result) {
    const { error } = await serviceClient()
      .from("agent_tool_effects")
      .update({
        status: "committed",
        result: result as unknown as Record<string, unknown>,
        committed_at: new Date().toISOString(),
      })
      .eq("run_id", run_id)
      .eq("tool_use_id", tool_use_id);
    if (error) throw new Error(error.message);
  },
  async release(run_id, tool_use_id) {
    const { error } = await serviceClient()
      .from("agent_tool_effects")
      .delete()
      .eq("run_id", run_id)
      .eq("tool_use_id", tool_use_id)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
  },
};

export async function renewPendingClaim(run_id: string, tool_use_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("agent_tool_effects")
    .update({ created_at: new Date().toISOString() })
    .eq("run_id", run_id)
    .eq("tool_use_id", tool_use_id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

function normalizeCommitted(v: CommittedEffect | McpCallResult | null): CommittedEffect | null {
  if (!v) return null;
  if ("result" in v && "input_hash" in v) return v as CommittedEffect;
  return { result: v as McpCallResult, input_hash: null };
}

export function defaultBusyResult(): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "tool_call_in_progress",
      message: "This same tool call is already running in another attempt. Try again shortly.",
    }),
    ms: 0,
  };
}

async function failOpen(stage: string, run_id: string, tool_use_id: string, e: unknown): Promise<void> {
  void tool_use_id;
  await logEvent({
    level: "warn",
    source: "mcp.tool-effect-ledger",
    code: `ledger_${stage}_failopen`,
    run_id,
    error: e instanceof Error ? e : new Error(String(e)),
  }).catch(() => {});
}

export async function runWithToolEffectGuard(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
  dispatch: () => Promise<McpCallResult>,
  deps: ToolEffectDeps = realToolEffectDeps,
  busyResult: () => McpCallResult = defaultBusyResult,
  opts: {
    takeover?: boolean;
    staleResult?: () => McpCallResult | Promise<McpCallResult>;
  } = {},
): Promise<McpCallResult> {
  const run_id = ctx.run_id;
  const tool_use_id = ctx.tool_use_id as string;
  const input_hash = hashToolInput(args);
  const matches = (c: CommittedEffect) => c.input_hash === null || c.input_hash === input_hash;

  try {
    const prior = normalizeCommitted(await deps.lookupCommitted(run_id, tool_use_id));
    if (prior) {
      if (matches(prior)) return prior.result;
      await logEvent({
        level: "warn",
        source: "mcp.tool-effect-ledger",
        code: "ledger_input_hash_mismatch",
        run_id,
      }).catch(() => {});
      return dispatch();
    }
  } catch (e) {
    await failOpen("lookup", run_id, tool_use_id, e);
  }

  let claimed = true;
  let stale = false;
  try {
    const inserted = await deps.claimPending({
      run_id,
      tenant_id: ctx.tenant_id,
      tool_use_id,
      iter: typeof ctx.iter === "number" ? ctx.iter : null,
      tool_name,
      input_hash,
      ...(opts.takeover === false ? { takeover: false } : {}),
    });
    stale = inserted === "stale";
    claimed = inserted !== false && !stale;
  } catch (e) {
    await failOpen("claim", run_id, tool_use_id, e);
  }
  if (!claimed) {
    try {
      const now = normalizeCommitted(await deps.lookupCommitted(run_id, tool_use_id));
      if (now && matches(now)) return now.result;
    } catch (e) {
      await failOpen("lookup", run_id, tool_use_id, e);
    }
    if (stale && opts.staleResult) return opts.staleResult();
    return busyResult();
  }

  const result = await dispatch();

  if (result.ok && !result.is_error) {
    try {
      await deps.commit(run_id, tool_use_id, result);
    } catch (e) {
      await failOpen("commit", run_id, tool_use_id, e);
    }
  } else if (deps.release) {
    try {
      await deps.release(run_id, tool_use_id);
    } catch (e) {
      await failOpen("release", run_id, tool_use_id, e);
    }
  }

  return result;
}
