
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { serviceClient } from "@/services/supabase";
import type { CallMcpContext } from "../execute";
import { resolveRepoFullName } from "@/services/agents/repo-resolver";
import { embedOne } from "@/services/memory/embed";
import { indexRepo, isCodeSymbolIndexEnabled } from "@/services/code-index/build";
import { canIndex } from "@/services/code-index/cost-cap";

const baseInput = z.object({
  symbol_name: z.string().min(1).describe("The symbol (function / class / method / type / const) to look up."),
  repo: z
    .string()
    .optional()
    .describe(
      "Optional owner/name. Omit to use the tenant's default connected repo. Must be a repo the tenant has connected.",
    ),
});

const codeDefInput = baseInput;
const codeRefsInput = baseInput;
const codeCallersInput = baseInput;

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const READ_SPECS: Record<string, SpecEntry> = {
  code_def: {
    description:
      "Find where a symbol is DEFINED in the tenant's connected repo — returns file path, line range, kind, and signature. Use before reading a whole file: locate the symbol here, then read just its line range. Semantic ranking when the exact name isn't found.",
    schema: codeDefInput,
    effect: "read",
  },
  code_refs: {
    description:
      "Find where a symbol is REFERENCED (identifier uses) across the tenant's connected repo — returns the file + line of each reference. Use to gauge blast-radius before changing a symbol.",
    schema: codeRefsInput,
    effect: "read",
  },
  code_callers: {
    description:
      "Find the CALL SITES of a function/method across the tenant's connected repo — returns each caller's file + line + enclosing symbol. Use to trace who invokes a function before editing its behavior.",
    schema: codeCallersInput,
    effect: "read",
  },
};

export function listCodeIndexTools(): McpTool[] {
  return Object.entries(READ_SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`code_index/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "code_index",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

type Mode = "def" | "refs" | "callers";

const TOOL_TO_MODE: Record<string, Mode> = {
  code_def: "def",
  code_refs: "refs",
  code_callers: "callers",
};

export async function callCodeIndexTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();

  if (!isCodeSymbolIndexEnabled()) {
    return degradeResult(start, "code index is disabled in this environment");
  }

  const spec = READ_SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `code_index/${tool_name} not registered`);
  }
  const mode = TOOL_TO_MODE[tool_name];

  let parsed: z.infer<typeof baseInput>;
  try {
    parsed = spec.schema.parse(args) as z.infer<typeof baseInput>;
  } catch (e) {
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    return degradeResult(start, `bad input: ${(e as Error)?.message?.slice(0, 160)}`);
  }

  try {
    let repo: string;
    try {
      repo = await resolveRepoFullName({
        tenant_id: ctx.tenant_id,
        repo_hint: parsed.repo ?? ctx.repo_full_name ?? null,
      });
    } catch (e) {
      return degradeResult(start, `repo not resolved: ${(e as Error)?.message?.slice(0, 200)}`);
    }

    let rows = await runQuery(ctx.tenant_id, repo, parsed.symbol_name, mode);

    if (rows.length === 0) {
      const committed = await hasCommittedGeneration(ctx.tenant_id, repo);
      if (committed === true) {
        const ageDays = await generationAgeDays(ctx.tenant_id, repo);
        if (ageDays !== null && ageDays > STALE_INDEX_DAYS) {
          await maybeKickBackgroundIndex(ctx.tenant_id, repo);
          return degradeResult(
            start,
            `the code index for ${repo} is ${ageDays} days old, so "${parsed.symbol_name}" being absent from it proves NOTHING — anything added since then is simply not in this snapshot. A refresh was started in the background. Use github__search_code / github__grep to check the CURRENT code, and do NOT report this symbol or feature as missing on the strength of this result.`,
          );
        }
        return degradeResult(
          start,
          `symbol "${parsed.symbol_name}" not found in the indexed generation of ${repo}${
            ageDays === null ? "" : ` (indexed ${ageDays} days ago)`
          } (the index is built; try github__search_code, or the symbol may not exist / be named differently).`,
        );
      }
      await maybeKickBackgroundIndex(ctx.tenant_id, repo);
      return degradeResult(
        start,
        `no index yet for ${repo} (symbol "${parsed.symbol_name}" not found). An index build was started in the background — use github__search_code / github__read_file for now and retry shortly.`,
      );
    }

    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        repo,
        symbol_name: parsed.symbol_name,
        mode,
        results: rows,
      }),
      ms: Date.now() - start,
    };
  } catch (e) {
    return degradeResult(start, `code index unavailable: ${(e as Error)?.message?.slice(0, 160)}`);
  }
}

type QueryRow = {
  symbol_name: string | null;
  kind: string | null;
  ref_kind: string | null;
  from_symbol: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  line: number | null;
  signature: string | null;
  score: number | null;
};

async function runQuery(
  tenant_id: string,
  repo: string,
  symbol_name: string,
  mode: Mode,
): Promise<QueryRow[]> {
  let queryEmbedding: number[] | null = null;
  if (mode === "def") {
    try {
      queryEmbedding = await embedOne(symbol_name, "query");
    } catch {
      queryEmbedding = null;
    }
  }

  const { data, error } = await serviceClient().rpc("code_symbol_query", {
    p_tenant_id: tenant_id,
    p_repo: repo,
    p_symbol_name: symbol_name,
    p_query_embedding: queryEmbedding,
    p_mode: mode,
  });
  if (error) {
    console.warn(`[code-index] code_symbol_query failed (${mode}) for ${repo}: ${error.message}`);
    return [];
  }
  return (data ?? []) as QueryRow[];
}

async function hasCommittedGeneration(
  tenant_id: string,
  repo: string,
): Promise<boolean | null> {
  const { data, error } = await serviceClient()
    .from("code_index_state")
    .select("current_build_id")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo)
    .maybeSingle();
  if (error) return null;
  return (data as { current_build_id?: string | null } | null)?.current_build_id != null;
}

const STALE_INDEX_DAYS = 14;

async function generationAgeDays(tenant_id: string, repo: string): Promise<number | null> {
  const { data, error } = await serviceClient()
    .from("code_index_state")
    .select("indexed_at")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo)
    .maybeSingle();
  if (error) return null;
  const indexedAt = (data as { indexed_at?: string | null } | null)?.indexed_at;
  if (!indexedAt) return null;
  const ms = Date.now() - new Date(indexedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

async function maybeKickBackgroundIndex(tenant_id: string, repo: string): Promise<void> {
  const cap = await canIndex(tenant_id).catch(() => ({ ok: false }) as { ok: boolean });
  if (!cap.ok) return;
  void indexRepo({ tenantId: tenant_id, repo })
    .then(async (r) => {
      try {
        await serviceClient().rpc("code_index_record_status", {
          p_tenant_id: tenant_id,
          p_repo: repo,
          p_status: r.status,
          p_error: r.detail ?? null,
        });
      } catch {
      }
      if (r.status !== "indexed") {
        console.warn(`[code-index] background index of ${repo} → ${r.status}: ${r.detail ?? ""}`);
      }
    })
    .catch((e) => console.warn(`[code-index] background index threw for ${repo}:`, e));
}

function degradeResult(start: number, message: string): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      status: "unavailable",
      fallback: ["github__search_code", "github__read_file"],
      message,
    }),
    ms: Date.now() - start,
  };
}

function errorResult(start: number, code: string, message: string): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message }),
    ms: Date.now() - start,
  };
}
