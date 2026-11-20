
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { serviceClient } from "@/services/supabase";
import { getSecret } from "@/services/secrets/vault";

const AddTestCaseInput = z.object({
  title: z.string().min(3).max(200),
  role: z.enum(["guest", "host", "public"]),
  nl_spec: z.object({
    steps: z.array(z.string().min(1)).min(1).max(20),
    expected_outcome: z.string().min(3).max(500),
    preconditions: z.array(z.string()).max(10).default([]),
  }),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
  created_by: z.enum(["agent-onboarding", "operator-chat"]),
});
export type AddTestCaseArgs = z.infer<typeof AddTestCaseInput>;

const ListActiveTestsInput = z.object({
  role: z.enum(["guest", "host", "public"]).optional(),
  limit: z.number().int().min(1).max(20).default(15),
});
export type ListActiveTestsArgs = z.infer<typeof ListActiveTestsInput>;

const RecordTestOutcomeInput = z
  .object({
    test_case_id: z.string().uuid(),
    status: z.enum(["passed", "failed", "healed", "errored"]),
    new_cached_steps_jsonb: z
      .array(z.record(z.string(), z.unknown()))
      .max(50)
      .optional(),
    unmute: z.boolean().default(false),
  })
  .refine(
    (d) => d.status !== "healed" || d.new_cached_steps_jsonb !== undefined,
    { message: "status='healed' requires new_cached_steps_jsonb" },
  )
  .refine(
    (d) =>
      d.new_cached_steps_jsonb === undefined ||
      d.status === "healed" ||
      d.status === "passed",
    {
      message:
        "new_cached_steps_jsonb only valid when status='healed' or 'passed' (cache must reflect a successful run)",
    },
  );
export type RecordTestOutcomeArgs = z.infer<typeof RecordTestOutcomeInput>;

const GetRuntimeConfigInput = z.object({});
export type GetRuntimeConfigArgs = z.infer<typeof GetRuntimeConfigInput>;

const CountTestCasesInput = z.object({});
export type CountTestCasesArgs = z.infer<typeof CountTestCasesInput>;

const READ_SPECS: Record<
  string,
  { description: string; schema: z.ZodTypeAny; effect: ToolEffect }
> = {
  list_active_tests: {
    description:
      "List the tenant's active test_cases (status='active'). Returns [{ id, title, role, nl_spec, cached_steps_jsonb, last_status, consecutive_red }]. Use last_status + consecutive_red to classify new-vs-persistent failures. Default limit 15.",
    schema: ListActiveTestsInput,
    effect: "read",
  },
  get_runtime_config: {
    description:
      "Read the tenant's QA runtime config from vault. Returns { staging_url, staging_origin, guest_email, guest_password, has_host_creds, host_email?, host_password? }. Mode B calls this at run-start to log into the staging site.",
    schema: GetRuntimeConfigInput,
    effect: "read",
  },
  count_test_cases: {
    description:
      "Count the tenant's test_cases. Returns { count, by_status:{active,muted,archived}, by_role:{guest,host,public} }. Call this BEFORE stating any catalog count or 'seeded'/'empty' claim — thread history is NOT a source of truth for catalog state (the operator may have added/archived cases via /catalog).",
    schema: CountTestCasesInput,
    effect: "read",
  },
};
const WRITE_SPECS: Record<
  string,
  { description: string; schema: z.ZodTypeAny; effect: ToolEffect }
> = {
  add_test_case: {
    description:
      "Insert one test case into the tenant's qa catalog. Used by Mode A (catalog-build, created_by='agent-onboarding') and Mode C (chat-add, created_by='operator-chat'). tenant_id is server-derived from the run context — do NOT pass it in args.",
    schema: AddTestCaseInput,
    effect: "write",
  },
  record_test_outcome: {
    description:
      "Record the outcome of a single test_case run. Updates last_status, last_run_at, consecutive_red. On status='healed' new_cached_steps_jsonb is REQUIRED (zod-enforced) and persisted with last_healed_at. On status='passed' new_cached_steps_jsonb is optional (seeds cache for previously-uncached rows). consecutive_red increments on failed/errored, resets to 0 on pass/healed; status flips to 'muted' at 3. Pass-after-mute does NOT auto-un-mute — call with { unmute: true } to flip muted→active.",
    schema: RecordTestOutcomeInput,
    effect: "write",
  },
};

export function listQaEngineerTools(): McpTool[] {
  return Object.entries({ ...READ_SPECS, ...WRITE_SPECS }).map(
    ([tool_name, spec]) => {
      const schema = zodToJsonSchema(spec.schema);
      if (schema.type !== "object") {
        throw new Error(
          `qa_engineer/${tool_name} input schema must be a top-level z.object()`,
        );
      }
      return {
        server_id: "qa_engineer",
        tool_name,
        description: spec.description,
        effect: spec.effect,
        input_schema: schema as { type: "object"; [k: string]: unknown },
      };
    },
  );
}

export async function callQaEngineerTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  try {
    if (tool_name === "add_test_case") {
      const parsed = AddTestCaseInput.parse(args);
      const { id } = await qaAddTestCase(ctx, parsed);
      return ok({ id }, start);
    }
    if (tool_name === "list_active_tests") {
      const parsed = ListActiveTestsInput.parse(args);
      const rows = await qaListActiveTests(ctx, parsed);
      return ok({ tests: rows }, start);
    }
    if (tool_name === "record_test_outcome") {
      const parsed = RecordTestOutcomeInput.parse(args);
      const updated = await qaRecordTestOutcome(ctx, parsed);
      return ok(updated, start);
    }
    if (tool_name === "get_runtime_config") {
      GetRuntimeConfigInput.parse(args);
      const cfg = await qaGetRuntimeConfig(ctx);
      return ok(cfg, start);
    }
    if (tool_name === "count_test_cases") {
      CountTestCasesInput.parse(args);
      const counts = await qaCountTestCases(ctx);
      return ok(counts, start);
    }
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `qa_engineer/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  } catch (e) {
    const msg =
      e instanceof ExpectedToolError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_error", message: msg }),
      ms: Date.now() - start,
    };
  }
}

function ok(value: unknown, start: number): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify(value),
    ms: Date.now() - start,
  };
}

function assertQaEngineerCallerAny(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
): void {
  if (
    ctx.agent_slug !== "qa" &&
    ctx.agent_slug !== "qa-engineer-weekly"
  ) {
    throw new Error(
      `qa_engineer.<tool>: run ${ctx.run_id} belongs to agent ${
        ctx.agent_slug ?? "<missing>"
      }, not qa family`,
    );
  }
}

export async function qaAddTestCase(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
  args: AddTestCaseArgs,
): Promise<{ id: string }> {
  assertQaEngineerCallerAny(ctx);
  const sb = serviceClient();
  const { data: ins, error: insErr } = await sb
    .from("test_cases")
    .insert({
      tenant_id: ctx.tenant_id,
      title: args.title,
      role: args.role,
      nl_spec: args.nl_spec,
      tags: args.tags,
      created_by: args.created_by,
    })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") {
      const { data: existing } = await sb
        .from("test_cases")
        .select("id")
        .eq("tenant_id", ctx.tenant_id)
        .ilike("title", args.title.trim())
        .neq("status", "archived")
        .maybeSingle();
      throw new ExpectedToolError(
        "duplicate_title",
        `a test case titled "${args.title}" already exists in this catalog${
          existing?.id ? ` (id ${existing.id})` : ""
        } — not added again`,
        existing?.id ? { existing_id: existing.id } : undefined,
      );
    }
    throw new Error(
      `qa_engineer.add_test_case: insert failed: ${insErr.message}`,
    );
  }
  if (!ins) {
    throw new Error(`qa_engineer.add_test_case: insert failed: no row`);
  }
  return { id: ins.id as string };
}

export type ActiveTestRow = {
  id: string;
  title: string;
  role: string;
  nl_spec: unknown;
  cached_steps_jsonb: unknown | null;
  last_status: string | null;
  consecutive_red: number;
};

export async function qaListActiveTests(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
  args: ListActiveTestsArgs,
): Promise<ActiveTestRow[]> {
  assertQaEngineerCallerAny(ctx);
  const sb = serviceClient();
  let q = sb
    .from("test_cases")
    .select(
      "id,title,role,nl_spec,cached_steps_jsonb,last_status,consecutive_red",
    )
    .eq("tenant_id", ctx.tenant_id)
    .eq("status", "active")
    .limit(args.limit);
  if (args.role) q = q.eq("role", args.role);
  const { data, error } = await q;
  if (error) {
    throw new Error(`qa_engineer.list_active_tests: ${error.message}`);
  }
  return (data ?? []) as ActiveTestRow[];
}

export type QaCountResult = {
  count: number;
  by_status: { active: number; muted: number; archived: number };
  by_role: { guest: number; host: number; public: number };
};

export async function qaCountTestCases(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
): Promise<QaCountResult> {
  assertQaEngineerCallerAny(ctx);
  const sb = serviceClient();
  const { data, error } = await sb
    .from("test_cases")
    .select("status, role")
    .eq("tenant_id", ctx.tenant_id);
  if (error) throw new Error(`qa_engineer.count_test_cases: ${error.message}`);
  const rows = data ?? [];
  const by_status = { active: 0, muted: 0, archived: 0 };
  const by_role = { guest: 0, host: 0, public: 0 };
  for (const r of rows) {
    if (r.status in by_status) (by_status as Record<string, number>)[r.status]++;
    if (r.role in by_role) (by_role as Record<string, number>)[r.role]++;
  }
  return { count: rows.length, by_status, by_role };
}

export async function qaRecordTestOutcome(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
  args: RecordTestOutcomeArgs,
): Promise<{
  id: string;
  status: string;
  last_status: string;
  consecutive_red: number;
}> {
  assertQaEngineerCallerAny(ctx);
  const sb = serviceClient();
  const { data: row, error: readErr } = await sb
    .from("test_cases")
    .select("id,status,consecutive_red,tenant_id")
    .eq("id", args.test_case_id)
    .maybeSingle();
  if (readErr || !row) {
    throw new Error(
      `qa_engineer.record_test_outcome: row not found: ${readErr?.message ?? "no row"}`,
    );
  }
  if (row.tenant_id !== ctx.tenant_id) {
    throw new Error(
      `qa_engineer.record_test_outcome: row ${args.test_case_id} belongs to a different tenant`,
    );
  }
  const reddish = args.status === "failed" || args.status === "errored";
  const newConsecRed = reddish ? (row.consecutive_red ?? 0) + 1 : 0;
  const wasActive = row.status === "active";
  let newStatus = row.status as string;
  if (newConsecRed >= 3) {
    newStatus = "muted";
  } else if (wasActive) {
    newStatus = "active";
  } else if (!reddish && args.unmute) {
    newStatus = "active";
  }

  const update: Record<string, unknown> = {
    last_status: args.status,
    last_run_at: new Date().toISOString(),
    consecutive_red: newConsecRed,
    status: newStatus,
  };
  if (args.new_cached_steps_jsonb !== undefined) {
    update.cached_steps_jsonb = args.new_cached_steps_jsonb;
    if (args.status === "healed") {
      update.last_healed_at = new Date().toISOString();
    }
  }
  const { data: updated, error: upErr } = await sb
    .from("test_cases")
    .update(update)
    .eq("id", args.test_case_id)
    .select("id,status,last_status,consecutive_red")
    .single();
  if (upErr || !updated) {
    throw new Error(
      `qa_engineer.record_test_outcome: update failed: ${upErr?.message ?? "no row"}`,
    );
  }
  return updated as {
    id: string;
    status: string;
    last_status: string;
    consecutive_red: number;
  };
}

export type QaRuntimeConfig = {
  staging_url: string | null;
  staging_origin: string | null;
  guest_email: string | null;
  guest_password: string | null;
  has_host_creds: boolean;
  host_email?: string;
  host_password?: string;
};

export async function qaGetRuntimeConfig(
  ctx: Pick<CallMcpContext, "tenant_id" | "run_id" | "agent_slug">,
): Promise<QaRuntimeConfig> {
  assertQaEngineerCallerAny(ctx);
  const safe = async (key: string): Promise<string | null> => {
    try {
      return await getSecret(ctx.tenant_id, key);
    } catch {
      return null;
    }
  };
  const staging = await safe("qa.staging_url");
  let stagingOrigin: string | null = null;
  if (staging) {
    try {
      stagingOrigin = new URL(staging).origin;
    } catch {
      stagingOrigin = null;
    }
  }
  const gEmail = await safe("qa.guest.email");
  const gPw = await safe("qa.guest.password");
  const hEmail = await safe("qa.host.email");
  const hPw = await safe("qa.host.password");
  const hasHost = Boolean(hEmail && hPw);
  return {
    staging_url: staging,
    staging_origin: stagingOrigin,
    guest_email: gEmail,
    guest_password: gPw,
    has_host_creds: hasHost,
    ...(hasHost ? { host_email: hEmail!, host_password: hPw! } : {}),
  };
}
