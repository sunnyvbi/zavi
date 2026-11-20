
import { serviceClient } from "@/services/supabase";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";

const CSV_MIME = "text/csv";

export type DeliverCsvCtx = {
  tenant_id: string;
  run_id: string;
};

export type DeliverCsvResult = {
  artifact_id: string;
  filename: string;
  bytes: number;
};

export async function deliverCsv(
  ctx: DeliverCsvCtx,
  input: { filename: string; csv: string },
): Promise<DeliverCsvResult> {
  const guardedTenantId = await assertRunTenantOwnership({
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
  });

  const bytes = Buffer.from(input.csv, "utf-8");
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new Error(`csv is ${bytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}.`);
  }

  const svc = serviceClient();
  const storagePath = `${guardedTenantId}/${ctx.run_id}/${input.filename}`;
  const { error: upErr } = await svc.storage
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: CSV_MIME,
      upsert: true,
    });
  if (upErr) {
    throw new Error(`storage upload failed: ${upErr.message}`);
  }

  const binding = await artifactRunBinding(ctx.run_id);
  const { data: rowData, error: rowErr } = await svc
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        storage_path: storagePath,
        filename: input.filename,
        title: input.filename.replace(/\.[^.]+$/, ""),
        mime: CSV_MIME,
        bytes: bytes.byteLength,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single();
  if (rowErr || !rowData) {
    throw new Error(`run_artifacts row upsert failed: ${rowErr?.message ?? "no id returned"}`);
  }
  trackDocumentDelivered({ tenant_id: guardedTenantId, mime: CSV_MIME });

  return {
    artifact_id: (rowData as { id: string }).id,
    filename: input.filename,
    bytes: bytes.byteLength,
  };
}
