
import { serviceClient } from "@/services/supabase";
import type { EmitProgress, ProgressMeta, ProgressStage } from "./types";

export function makeEmitProgress(
  agent_run_id: string,
  tenant_id: string,
): EmitProgress {
  return async (stage: ProgressStage, meta?: ProgressMeta) => {
    const sanitizedMeta: ProgressMeta = {};
    if (meta?.tool_name && typeof meta.tool_name === "string") {
      sanitizedMeta.tool_name = meta.tool_name.slice(0, 64);
    }
    if (typeof meta?.ms === "number" && Number.isFinite(meta.ms)) {
      sanitizedMeta.ms = Math.max(0, Math.floor(meta.ms));
    }
    if (meta?.code && typeof meta.code === "string") {
      sanitizedMeta.code = meta.code.slice(0, 64);
    }
    if (typeof meta?.iter === "number" && Number.isFinite(meta.iter)) {
      sanitizedMeta.iter = Math.max(0, Math.floor(meta.iter));
    }

    try {
      const { error } = await serviceClient().from("agent_run_events").insert({
        agent_run_id,
        tenant_id,
        stage,
        meta: sanitizedMeta,
      });
      if (error) {
        console.warn(
          `[progress] failed to emit ${stage} for run=${agent_run_id}: ${error.message}`,
        );
      }
    } catch (e) {
      console.warn(
        `[progress] exception emitting ${stage} for run=${agent_run_id}: ${(e as Error).message}`,
      );
    }
  };
}
