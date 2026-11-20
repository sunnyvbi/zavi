
import { z } from "zod";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { ExpectedToolError } from "@/services/tools/types";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";
import { sanitizeArtifactFilename } from "@/services/sandbox/tool-registry";
import { renderDocInputSchema } from "./doc-schema";
import { renderDocHtml } from "./render-doc-html";
import { docThemeFromBrand, DEFAULT_DOC_THEME } from "./brand-theme";
import { resolveBrandKit } from "@/services/brand/resolve-brand-kit";
import { publishDocLink } from "@/services/agents/prototype-links";

const HTML_MIME = "text/html";

export const PUBLIC_LINK_DISCLOSURE =
  "Anyone with this link can open this page — it is public and needs no sign-in.";

export const deliverDocInputSchema = renderDocInputSchema.extend({
  filename: z.string().min(1).max(120),
});
export type DeliverDocInput = z.infer<typeof deliverDocInputSchema>;

export type DeliverDocCtx = {
  tenant_id: string;
  run_id: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type DeliverDocResult = {
  artifact_id: string;
  filename: string;
  bytes: number;
  url: string | null;
  link_error?: "disabled" | "blocked" | "error";
  link_disclosure?: string;
};

export async function deliverDoc(
  ctx: DeliverDocCtx,
  rawInput: unknown,
): Promise<DeliverDocResult> {
  const input = deliverDocInputSchema.parse(rawInput);
  await assertRunTenantOwnership({ tenant_id: ctx.tenant_id, run_id: ctx.run_id });

  const filename = sanitizeArtifactFilename(
    input.filename.endsWith(".html") ? input.filename : `${input.filename}.html`,
  );

  let theme = DEFAULT_DOC_THEME;
  try {
    theme = docThemeFromBrand(await resolveBrandKit(ctx.tenant_id));
  } catch (e) {
    ctx.log?.("brand_theme_unresolved", {
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
  }

  const summary = input.subtitle ?? input.sections[0]?.heading ?? input.title;
  let published: Awaited<ReturnType<typeof publishDocLink>>;
  try {
    published = await publishDocLink({
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      title: input.title,
      summary,
      html: renderDocHtml(input, PUBLIC_LINK_DISCLOSURE, theme),
    });
  } catch {
    published = { published: false, reason: "error" };
  }

  const url = published.published ? published.url : null;
  const html = renderDocHtml(input, url ? PUBLIC_LINK_DISCLOSURE : undefined, theme);
  const bytes = Buffer.byteLength(html, "utf-8");
  if (bytes > ARTIFACT_MAX_BYTES) {
    throw new ExpectedToolError(
      `Rendered document is ${bytes} bytes, over the ${ARTIFACT_MAX_BYTES} limit. Split it into fewer sections.`,
    );
  }

  const tid = asTenantId(ctx.tenant_id);
  const storagePath = `${ctx.tenant_id}/${ctx.run_id}/${filename}`;
  const { error: upErr } = await tenantStorage(tid)
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, Buffer.from(html, "utf-8"), {
      contentType: HTML_MIME,
      upsert: true,
    });
  if (upErr) throw new ExpectedToolError(`Could not store the document: ${upErr.message}`);

  const binding = await artifactRunBinding(ctx.run_id);
  const { data, error } = await tenantClient(tid)
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
        title: input.title,
        filename,
        storage_path: storagePath,
        mime: HTML_MIME,
        bytes,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single();
  if (error) throw new ExpectedToolError(`Could not record the document: ${error.message}`);
  trackDocumentDelivered({ tenant_id: ctx.tenant_id, mime: HTML_MIME });

  void logEvent({
    level: "info",
    source: "reports.render-doc",
    code: "doc_rendered",
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
    meta: {
      bytes,
      sections: input.sections.length,
      published: Boolean(url),
      link_error: published.published ? undefined : published.reason,
    },
  });

  return {
    artifact_id: String(data.id),
    filename,
    bytes,
    url,
    ...(published.published ? {} : { link_error: published.reason }),
    ...(url ? { link_disclosure: PUBLIC_LINK_DISCLOSURE } : {}),
  };
}
