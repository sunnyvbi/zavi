
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";
import { buildXlsx, XLSX_MIME } from "./xlsx";
import type { RenderXlsxInput } from "./schema";

export type DeliverXlsxCtx = {
  tenant_id: string;
  run_id: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type DeliverXlsxResult = {
  artifact_id: string;
  filename: string;
  bytes: number;
  sheets: Array<{ name: string; rows: number; columns: number }>;
};

export async function deliverXlsx(
  ctx: DeliverXlsxCtx,
  input: RenderXlsxInput,
  filename: string,
): Promise<DeliverXlsxResult> {
  const guardedTenantId = await assertRunTenantOwnership({
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
  });
  const tid = asTenantId(guardedTenantId);
  const db = tenantClient(tid);

  let bytes: Buffer;
  try {
    bytes = await buildXlsx(input);
  } catch (e) {
    throw new ExpectedToolError(
      "xlsx_render_failed",
      (e instanceof Error ? e.message : String(e)).slice(0, 300),
    );
  }
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new ExpectedToolError(
      "xlsx_too_large",
      `workbook is ${bytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}. Narrow the export.`,
    );
  }

  const storagePath = `${guardedTenantId}/${ctx.run_id}/${filename}`;
  const { error: upErr } = await tenantStorage(tid)
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, bytes, { contentType: XLSX_MIME, upsert: true });
  if (upErr) {
    throw new ExpectedToolError("storage_upload_failed", upErr.message);
  }

  const binding = await artifactRunBinding(ctx.run_id);
  const { data: rowData, error: rowErr } = await db
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        storage_path: storagePath,
        filename,
        title: filename.replace(/\.[^.]+$/, ""),
        mime: XLSX_MIME,
        bytes: bytes.byteLength,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single();
  if (rowErr || !rowData) {
    throw new ExpectedToolError(
      "artifact_row_failed",
      rowErr?.message ?? "row upsert failed",
    );
  }
  trackDocumentDelivered({ tenant_id: guardedTenantId, mime: XLSX_MIME });

  return {
    artifact_id: (rowData as { id: string }).id,
    filename,
    bytes: bytes.byteLength,
    sheets: input.sheets.map((s) => ({
      name: s.name,
      rows: s.rows.length,
      columns: s.columns.length,
    })),
  };
}
