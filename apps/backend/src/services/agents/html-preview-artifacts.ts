import { createHash } from "node:crypto";
import * as parse5 from "parse5";
import { assertRunTenantOwnership } from "@/services/reports/guard";
import { trackPrototypePublished } from "@/services/analytics/action-events";
import {
  asTenantId,
  tenantClient,
  tenantStorage,
} from "@/services/tenant-client";
import {
  HTML_PREVIEW_MAX_CHARS,
  htmlPreviewDesignSpecSchema,
  type HtmlPreviewDesignSpec,
} from "@/agents/engineer/output-schema";

export const HTML_PREVIEW_BUCKET = "engineer-html-previews";
export const HTML_PREVIEW_ENVELOPE_VERSION = 2 as const;
export const HTML_PREVIEW_MAX_ATTEMPTS = 2;

export const HTML_PREVIEW_FAILURE_REASONS = [
  "artifact_empty",
  "artifact_oversized",
  "artifact_unsafe",
  "artifact_storage_failed",
  "artifact_missing",
  "malformed_metadata",
  "metadata_mismatch",
  "truncated_response",
  "retry_exhausted",
] as const;

export type HtmlPreviewFailureReason =
  (typeof HTML_PREVIEW_FAILURE_REASONS)[number];
export type HtmlPreviewArtifactState =
  | "html_preview_ready"
  | "html_preview_failed";

const FAILURE_SENTENCE: Record<HtmlPreviewFailureReason, string> = {
  artifact_empty: "the preview came back empty",
  artifact_oversized: "the preview was too large to store",
  artifact_unsafe: "the preview was blocked by a safety check",
  artifact_storage_failed: "the preview could not be saved",
  artifact_missing: "the preview was written but could not be found afterwards",
  malformed_metadata: "the preview's metadata was malformed",
  metadata_mismatch: "the preview's metadata did not match the file",
  truncated_response: "the response was cut off before the preview finished",
  retry_exhausted: "the preview failed on every retry",
};

export function htmlPreviewFailureMessage(
  reason: HtmlPreviewFailureReason,
  keptProse?: string | null,
): string {
  const why = FAILURE_SENTENCE[reason] ?? "the preview did not render";
  const note =
    `I could not show the preview — ${why}. ` +
    `I have not built anything or opened a PR. Ask me to retry and I will try the preview again.`;
  const prose = (keptProse ?? "").trim();
  return prose ? `${note}\n\nWhat I had written before it failed:\n\n${prose}` : note;
}

type PreviewRow = {
  id: string;
  tenant_id: string;
  run_id: string;
  status: HtmlPreviewArtifactState;
  failure_reason: HtmlPreviewFailureReason | null;
  attempt_count: number;
  title: string;
  summary: string;
  design_spec: HtmlPreviewDesignSpec | null;
  storage_path: string | null;
  sanitized_bytes: number | null;
  sha256: string | null;
  displayed_at: string | null;
};

export function previewArtifactMatchesScope(
  row: Pick<PreviewRow, "id" | "tenant_id" | "run_id">,
  scope: { tenant_id: string; preview_id: string; run_id?: string },
): boolean {
  return (
    row.id === scope.preview_id &&
    row.tenant_id === scope.tenant_id &&
    (!scope.run_id || row.run_id === scope.run_id)
  );
}

export type StagePreviewInput = {
  tenant_id: string;
  run_id: string;
  title: string;
  summary: string;
  html: string;
  design_spec?: unknown;
};

export type StagePreviewResult =
  | {
      ok: true;
      preview_id: string;
      version: typeof HTML_PREVIEW_ENVELOPE_VERSION;
      state: "html_preview_ready";
      title: string;
      summary: string;
      design_spec?: HtmlPreviewDesignSpec;
      sanitized_bytes: number;
    }
  | {
      ok: false;
      state: "html_preview_failed";
      failure_reason: HtmlPreviewFailureReason;
      retry_allowed: boolean;
      attempts_used: number;
    };

export function nextPreviewAttempt(
  existing:
    | { status: HtmlPreviewArtifactState; attempt_count: number }
    | null,
): { allowed: true; attempt: 1 | 2 } | { allowed: false } {
  if (existing?.status === "html_preview_ready") return { allowed: false };
  const used = Math.max(0, existing?.attempt_count ?? 0);
  if (used >= HTML_PREVIEW_MAX_ATTEMPTS) return { allowed: false };
  return { allowed: true, attempt: (used + 1) as 1 | 2 };
}

const DROP_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "link",
]);
const DROP_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "href",
  "action",
  "formaction",
  "ping",
  "poster",
  "data",
  "integrity",
  "nonce",
]);

function sanitizeCss(value: string): string {
  return value
    .replace(/@import[\s\S]*?(?:;|$)/gi, "")
    .replace(/url\s*\([\s\S]*?\)/gi, "none")
    .replace(/expression\s*\([\s\S]*?\)/gi, "")
    .replace(/-moz-binding\s*:[^;}]*/gi, "");
}

type ParseNode = {
  nodeName?: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParseNode[];
  parentNode?: ParseNode;
  value?: string;
};

export type SanitizeHtmlOptions = {
  allowScripts?: boolean;
};

const SCRIPT_NAVIGATION_RE = /\blocation\b|\bwindow\s*\.\s*open\b|\btop\s*\.|\bparent\s*\.|\bdocument\s*\.\s*(?:write|domain)\b|\bimport\s*\(|\bnavigator\s*\.\s*sendBeacon\b/;

export function scriptTextIsSafe(js: string): boolean {
  return !SCRIPT_NAVIGATION_RE.test(js);
}

function sanitizeNode(node: ParseNode, opts: SanitizeHtmlOptions = {}): void {
  if (node.tagName === "meta") {
    const refresh = node.attrs?.some(
      (a) => a.name.toLowerCase() === "http-equiv" && a.value.toLowerCase() === "refresh",
    );
    if (refresh && node.parentNode?.childNodes) {
      node.parentNode.childNodes = node.parentNode.childNodes.filter((n) => n !== node);
      return;
    }
  }

  if (node.attrs) {
    node.attrs = node.attrs
      .filter((a) => {
        const name = a.name.toLowerCase();
        if (name.startsWith("on")) {
          if (!opts.allowScripts) return false;
          if (!scriptTextIsSafe(a.value)) throw new Error("unsafe_handler");
          return true;
        }
        return !DROP_ATTRIBUTES.has(name);
      })
      .map((a) =>
        a.name.toLowerCase() === "style"
          ? { ...a, value: sanitizeCss(a.value) }
          : a,
      );
  }

  if (node.tagName === "style" && node.childNodes) {
    for (const child of node.childNodes) {
      if (child.nodeName === "#text" && typeof child.value === "string") {
        child.value = sanitizeCss(child.value);
      }
    }
  }

  if (node.tagName === "script" && opts.allowScripts) {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === "#text" && typeof child.value === "string" && !scriptTextIsSafe(child.value)) {
        throw new Error("unsafe_script");
      }
    }
  }

  if (!node.childNodes) return;
  node.childNodes = node.childNodes.filter(
    (child) =>
      !child.tagName ||
      !DROP_ELEMENTS.has(child.tagName) ||
      (opts.allowScripts && child.tagName === "script"),
  );
  for (const child of node.childNodes) sanitizeNode(child, opts);
}

export function sanitizePreviewHtml(
  raw: string,
  opts: SanitizeHtmlOptions = {},
):
  | { ok: true; html: string; bytes: number; sha256: string }
  | { ok: false; reason: HtmlPreviewFailureReason } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "artifact_empty" };
  }
  if (raw.length > HTML_PREVIEW_MAX_CHARS) {
    return { ok: false, reason: "artifact_oversized" };
  }

  try {
    const doc = parse5.parse(raw) as unknown as ParseNode;
    sanitizeNode(doc, opts);
    const html = parse5.serialize(doc as never);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes === 0) return { ok: false, reason: "artifact_empty" };
    if (bytes > HTML_PREVIEW_MAX_CHARS) {
      return { ok: false, reason: "artifact_oversized" };
    }
    return {
      ok: true,
      html,
      bytes,
      sha256: createHash("sha256").update(html, "utf8").digest("hex"),
    };
  } catch {
    return { ok: false, reason: "artifact_unsafe" };
  }
}

function cleanTitle(value: string): string {
  return value.trim().slice(0, 120);
}

function cleanSummary(value: string): string {
  return value.trim().slice(0, 4000);
}

export async function loadRunHtmlPreviewState(args: {
  tenant_id: string;
  run_id: string;
}): Promise<{ status: HtmlPreviewArtifactState; attempt_count: number } | null> {
  try {
    const row = await loadRunPreview(args.tenant_id, args.run_id);
    return row ? { status: row.status, attempt_count: row.attempt_count } : null;
  } catch {
    return null;
  }
}

async function loadRunPreview(
  tenant_id: string,
  run_id: string,
): Promise<PreviewRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("engineer_html_preview_artifacts")
    .select(
      "id,tenant_id,run_id,status,failure_reason,attempt_count,title,summary,design_spec,storage_path,sanitized_bytes,sha256,displayed_at",
    )
    .eq("run_id", run_id)
    .maybeSingle<PreviewRow>();
  if (error) throw new Error(`preview_row_read_failed:${error.message}`);
  return data ?? null;
}

async function persistFailure(args: {
  tenant_id: string;
  run_id: string;
  title: string;
  summary: string;
  design_spec?: HtmlPreviewDesignSpec;
  failure_reason: HtmlPreviewFailureReason;
  attempt_count: number;
}): Promise<void> {
  const { error } = await tenantClient(asTenantId(args.tenant_id))
    .from("engineer_html_preview_artifacts")
    .upsert(
      {
        run_id: args.run_id,
        status: "html_preview_failed",
        failure_reason: args.failure_reason,
        attempt_count: args.attempt_count,
        title: args.title || "Preview unavailable",
        summary: args.summary,
        design_spec: args.design_spec ?? null,
        storage_path: null,
        sanitized_bytes: null,
        sha256: null,
        displayed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,run_id" },
    );
  if (error) throw new Error(`preview_failure_write_failed:${error.message}`);
}

export async function stageHtmlPreviewArtifact(
  input: StagePreviewInput,
): Promise<StagePreviewResult> {
  await assertRunTenantOwnership({
    tenant_id: input.tenant_id,
    run_id: input.run_id,
  });

  const existing = await loadRunPreview(input.tenant_id, input.run_id);
  if (existing?.status === "html_preview_ready") {
    return {
      ok: true,
      preview_id: existing.id,
      version: HTML_PREVIEW_ENVELOPE_VERSION,
      state: "html_preview_ready",
      title: existing.title,
      summary: existing.summary,
      ...(existing.design_spec ? { design_spec: existing.design_spec } : {}),
      sanitized_bytes: existing.sanitized_bytes ?? 0,
    };
  }
  const attemptDecision = nextPreviewAttempt(existing);
  if (!attemptDecision.allowed) {
    return {
      ok: false,
      state: "html_preview_failed",
      failure_reason: "retry_exhausted",
      retry_allowed: false,
      attempts_used: HTML_PREVIEW_MAX_ATTEMPTS,
    };
  }

  const attempt = attemptDecision.attempt;
  const title = cleanTitle(input.title) || "Proposed design";
  const summary = cleanSummary(input.summary);
  const spec = htmlPreviewDesignSpecSchema.safeParse(input.design_spec);
  const design_spec = spec.success ? spec.data : undefined;
  const sanitized = sanitizePreviewHtml(input.html);
  if (!sanitized.ok) {
    await persistFailure({
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      title,
      summary,
      design_spec,
      failure_reason: sanitized.reason,
      attempt_count: attempt,
    });
    return {
      ok: false,
      state: "html_preview_failed",
      failure_reason: sanitized.reason,
      retry_allowed: attempt < HTML_PREVIEW_MAX_ATTEMPTS,
      attempts_used: attempt,
    };
  }

  const tid = asTenantId(input.tenant_id);
  const db = tenantClient(tid);
  const { data: row, error: rowError } = await db
    .from("engineer_html_preview_artifacts")
    .upsert(
      {
        run_id: input.run_id,
        status: "html_preview_failed",
        failure_reason: "artifact_storage_failed",
        attempt_count: attempt,
        title,
        summary,
        design_spec: design_spec ?? null,
        storage_path: null,
        sanitized_bytes: null,
        sha256: null,
        displayed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,run_id" },
    )
    .select("id")
    .single<{ id: string }>();
  if (rowError || !row) {
    throw new Error(`preview_row_write_failed:${rowError?.message ?? "missing_row"}`);
  }

  const storage_path = `${input.tenant_id}/${input.run_id}/${row.id}.html`;
  const { error: uploadError } = await tenantStorage(tid)
    .from(HTML_PREVIEW_BUCKET)
    .upload(storage_path, Buffer.from(sanitized.html, "utf8"), {
      contentType: "text/html",
      upsert: true,
    });
  if (uploadError) {
    return {
      ok: false,
      state: "html_preview_failed",
      failure_reason: "artifact_storage_failed",
      retry_allowed: attempt < HTML_PREVIEW_MAX_ATTEMPTS,
      attempts_used: attempt,
    };
  }

  const { error: readyError } = await db
    .from("engineer_html_preview_artifacts")
    .update({
      status: "html_preview_ready",
      failure_reason: null,
      storage_path,
      sanitized_bytes: sanitized.bytes,
      sha256: sanitized.sha256,
      displayed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("run_id", input.run_id);
  if (readyError) {
    await tenantStorage(tid).from(HTML_PREVIEW_BUCKET).remove([storage_path]);
    throw new Error(`preview_ready_write_failed:${readyError.message}`);
  }
  trackPrototypePublished({ tenant_id: input.tenant_id, prototype: "html_preview" });

  return {
    ok: true,
    preview_id: row.id,
    version: HTML_PREVIEW_ENVELOPE_VERSION,
    state: "html_preview_ready",
    title,
    summary,
    ...(design_spec ? { design_spec } : {}),
    sanitized_bytes: sanitized.bytes,
  };
}

export async function loadReadyHtmlPreview(args: {
  tenant_id: string;
  preview_id: string;
  run_id?: string;
}): Promise<{ row: PreviewRow; html: string } | null> {
  const tid = asTenantId(args.tenant_id);
  let query = tenantClient(tid)
    .from("engineer_html_preview_artifacts")
    .select(
      "id,tenant_id,run_id,status,failure_reason,attempt_count,title,summary,design_spec,storage_path,sanitized_bytes,sha256,displayed_at",
    )
    .eq("id", args.preview_id)
    .eq("status", "html_preview_ready");
  if (args.run_id) query = query.eq("run_id", args.run_id);
  const { data, error } = await query.maybeSingle<PreviewRow>();
  if (
    error ||
    !data?.storage_path ||
    !previewArtifactMatchesScope(data, args)
  ) {
    return null;
  }

  const { data: blob, error: downloadError } = await tenantStorage(tid)
    .from(HTML_PREVIEW_BUCKET)
    .download(data.storage_path);
  if (downloadError || !blob) return null;
  const html = await blob.text();
  const bytes = Buffer.byteLength(html, "utf8");
  const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
  if (
    bytes !== data.sanitized_bytes ||
    sha256 !== data.sha256 ||
    bytes > HTML_PREVIEW_MAX_CHARS
  ) {
    return null;
  }
  return { row: data, html };
}

export async function markHtmlPreviewDisplayed(args: {
  tenant_id: string;
  preview_id: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("engineer_html_preview_artifacts")
    .update({ displayed_at: now, updated_at: now })
    .eq("id", args.preview_id)
    .eq("status", "html_preview_ready")
    .not("storage_path", "is", null)
    .select("id")
    .maybeSingle<{ id: string }>();
  return !error && Boolean(data);
}

export async function markHtmlPreviewFailed(args: {
  tenant_id: string;
  run_id: string;
  failure_reason: HtmlPreviewFailureReason;
  title?: string;
  summary?: string;
}): Promise<void> {
  await assertRunTenantOwnership({
    tenant_id: args.tenant_id,
    run_id: args.run_id,
  });
  const existing = await loadRunPreview(args.tenant_id, args.run_id);
  const attempt = Math.min(
    HTML_PREVIEW_MAX_ATTEMPTS,
    Math.max(1, existing?.attempt_count ?? 1),
  );
  await persistFailure({
    tenant_id: args.tenant_id,
    run_id: args.run_id,
    title: cleanTitle(args.title ?? existing?.title ?? "Preview unavailable"),
    summary: cleanSummary(args.summary ?? existing?.summary ?? ""),
    design_spec: existing?.design_spec ?? undefined,
    failure_reason: args.failure_reason,
    attempt_count: attempt,
  });
}
