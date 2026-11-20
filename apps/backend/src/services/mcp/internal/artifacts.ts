
import type { ToolEffect } from "@/services/tools/types";
import { z, ZodError } from "zod";
import pdfParse from "pdf-parse";
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";
import { decideTenantOwnership } from "@/services/governance/tenant-ownership";
import { zodToJsonSchema } from "@/services/tools/registry";
import { ARTIFACT_BUCKET } from "@/services/reports/constants";

const PDF_MIME = "application/pdf";

const MAX_LIST_ROWS = 20;
const CONTENT_CAP_BYTES = 64 * 1024;

const listInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_ROWS)
    .optional()
    .describe(`Max rows to return (default + cap ${MAX_LIST_ROWS}).`),
});

const getInputSchema = z.object({
  artifact_id: z
    .string()
    .uuid()
    .describe("Artifact id from artifacts__list."),
});

function isTextishMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m.endsWith("+json") ||
    m === "application/csv" ||
    m === "application/markdown"
  );
}

type ArtifactRow = {
  id: string;
  tenant_id: string;
  agent_slug: string | null;
  run_id: string;
  storage_path: string;
  filename: string;
  mime: string;
  bytes: number;
  thread_id: string | null;
  created_at: string;
};

async function deriveRunScope(
  ctx: CallMcpContext,
): Promise<{ tenant_id: string; agent_slug: string }> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, agent_slug")
    .eq("id", ctx.run_id)
    .single();
  if (error || !data) {
    throw new ExpectedToolError(
      "run_lookup_failed",
      error?.message ?? "run not found",
    );
  }
  const row = data as { tenant_id: string; agent_slug: string };
  const ownership = decideTenantOwnership({
    callerTenantId: ctx.tenant_id,
    canonicalTenantId: row.tenant_id,
  });
  if (!ownership.allow) {
    throw new ExpectedToolError(
      "tenant_mismatch",
      "run does not belong to the calling tenant.",
    );
  }
  return { tenant_id: row.tenant_id, agent_slug: row.agent_slug };
}

async function artifactsList(
  ctx: CallMcpContext,
  input: z.infer<typeof listInputSchema>,
): Promise<unknown> {
  const scope = await deriveRunScope(ctx);
  const limit = input.limit ?? MAX_LIST_ROWS;
  const { data, error } = await serviceClient()
    .from("run_artifacts")
    .select("id, filename, mime, thread_id, created_at, bytes")
    .eq("tenant_id", scope.tenant_id)
    .eq("agent_slug", scope.agent_slug)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new ExpectedToolError("artifacts_list_failed", error.message);
  }
  return {
    artifacts: (data ?? []) as Pick<
      ArtifactRow,
      "id" | "filename" | "mime" | "thread_id" | "created_at" | "bytes"
    >[],
  };
}

async function artifactsGet(
  ctx: CallMcpContext,
  input: z.infer<typeof getInputSchema>,
): Promise<unknown> {
  const scope = await deriveRunScope(ctx);
  const { data, error } = await serviceClient()
    .from("run_artifacts")
    .select(
      "id, tenant_id, agent_slug, run_id, storage_path, filename, mime, bytes, thread_id, created_at",
    )
    .eq("id", input.artifact_id)
    .single();
  const row = (data ?? null) as ArtifactRow | null;
  if (
    error ||
    !row ||
    row.tenant_id !== scope.tenant_id ||
    row.agent_slug !== scope.agent_slug ||
    !row.storage_path.startsWith(`${scope.tenant_id}/`)
  ) {
    throw new ExpectedToolError(
      "not_found",
      "artifact not found for this agent.",
    );
  }

  const meta = {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    thread_id: row.thread_id,
    created_at: row.created_at,
  };

  const isPdf = row.mime.toLowerCase() === PDF_MIME;
  const isText = isTextishMime(row.mime);

  if (!isText && !isPdf) {
    return {
      ...meta,
      content: null,
      message:
        "binary artifact — can't read inline; ask the user to open it from the thread it was delivered in, or regenerate it.",
    };
  }

  const { data: blob, error: dlErr } = await serviceClient()
    .storage.from(ARTIFACT_BUCKET)
    .download(row.storage_path);
  if (dlErr || !blob) {
    throw new ExpectedToolError(
      "artifact_read_failed",
      dlErr?.message ?? "could not read artifact bytes",
    );
  }
  const buf = Buffer.from(await blob.arrayBuffer());

  if (isPdf) {
    let text = "";
    try {
      const parsed = await pdfParse(buf);
      text = (parsed.text ?? "").trim();
    } catch (e) {
      return {
        ...meta,
        content: null,
        message: `could not extract text from this PDF (${
          (e as Error).message
        }); it may be encrypted or corrupt. Ask the user to open it from the thread it was delivered in, or regenerate it.`,
      };
    }
    if (!text) {
      return {
        ...meta,
        content: null,
        message:
          "this PDF has no extractable text (likely image-only or scanned). Ask the user to open it from the thread it was delivered in, or regenerate it.",
      };
    }
    const truncated = text.length > CONTENT_CAP_BYTES;
    return {
      ...meta,
      content: truncated ? text.slice(0, CONTENT_CAP_BYTES) : text,
      truncated,
      ...(truncated
        ? {
            message: `extracted PDF text truncated to ${CONTENT_CAP_BYTES} chars (full text is ${text.length} chars).`,
          }
        : {}),
    };
  }

  const truncated = buf.byteLength > CONTENT_CAP_BYTES;
  const content = buf.subarray(0, CONTENT_CAP_BYTES).toString("utf-8");
  return {
    ...meta,
    content,
    truncated,
    ...(truncated
      ? {
          message: `content truncated to ${CONTENT_CAP_BYTES} bytes (full file is ${buf.byteLength} bytes).`,
        }
      : {}),
  };
}

const TOOLS: {
  tool_name: string;
  description: string;
  input_schema: z.ZodTypeAny;
  effect: ToolEffect;
  execute: (ctx: CallMcpContext, input: never) => Promise<unknown>;
}[] = [
  {
    tool_name: "list",
    description:
      "List the most recent files THIS agent delivered for this company — across ALL chat threads, not just the current one (PDFs/CSVs from report__render_pdf or sandbox emit_artifact). When the user references a doc/PDF/report you don't see in the current thread ('the PDF you made last week'), call this FIRST instead of saying you can't find it. If more than one row plausibly matches, ask ONE clarifying question naming the candidates (filename + date) before fetching. Returns [{id, filename, mime, thread_id, created_at, bytes}]. Scope is server-derived: same tenant + same agent only.",
    input_schema: listInputSchema,
    effect: "read",
    execute: artifactsList,
  },
  {
    tool_name: "get",
    description:
      "Fetch ONE artifact by id (from artifacts__list). Text-ish files (CSV/JSON/markdown/plain text) AND PDFs return their content inline — PDF text is extracted — capped at 64KB (a `truncated` flag tells you when). Other binaries (XLSX, images) return metadata only. NEVER invent contents: if the response has content:null (a non-readable binary, or a PDF that's image-only/scanned or encrypted), tell the user you couldn't read it and to open it from the thread it was delivered in or regenerate it — do NOT guess. Ids outside this agent's own artifact set return not_found.",
    input_schema: getInputSchema,
    effect: "read",
    execute: artifactsGet,
  },
];

export function listArtifactsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool artifacts/${t.tool_name} must be a top-level z.object()`);
    }
    return {
      server_id: "artifacts",
      tool_name: t.tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callArtifactsTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = TOOLS.find((t) => t.tool_name === tool_name);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `artifacts/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  if (!ctx.run_id) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "missing_run_ctx",
        message: "artifacts tools require an active run_id in context",
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args) as never;
    const output = await spec.execute(ctx, parsedInput);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "invalid_input",
          message: e.issues.map((er) => er.message).join("; "),
        }),
        ms: Date.now() - start,
      };
    }
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: e.code,
          message: e.message,
          ...(e.meta ? { meta: e.meta } : {}),
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
