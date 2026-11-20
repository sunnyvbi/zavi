
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import {
  CHAT_IMAGE_BUCKET,
  normalizeChatImage,
  storeNormalizedChatImage,
} from "@/services/chat-images/store-chat-image";
import { hasCurrentExtensionConsent } from "@/services/extension/consent";
import { EXTENSION_SCREENSHOTS_TABLE } from "@/services/extension/screenshots";

export const MAX_TASK_STEP_SCREENSHOTS = 5;

export type TaskStepSaveResult =
  | { ok: true; image_path: string }
  | { ok: false; code: "consent_required" | "task_step_cap" | "count_failed" | "store_failed" };

export async function saveTaskStepScreenshot(args: {
  tenant_id: string;
  user_id: string;
  run_id: string;
  image: Buffer;
}): Promise<TaskStepSaveResult> {
  const { tenant_id, user_id, run_id } = args;
  if (!(await hasCurrentExtensionConsent(tenant_id, user_id))) {
    return { ok: false, code: "consent_required" };
  }

  const scoped = tenantClient(asTenantId(tenant_id));
  try {
    const { count, error } = await scoped
      .from(EXTENSION_SCREENSHOTS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("user_id", user_id)
      .eq("run_id", run_id)
      .eq("kind", "task_step");
    if (error || typeof count !== "number") return { ok: false, code: "count_failed" };
    if (count >= MAX_TASK_STEP_SCREENSHOTS) return { ok: false, code: "task_step_cap" };
  } catch {
    return { ok: false, code: "count_failed" };
  }

  const normalized = await normalizeChatImage(args.image);
  if (!normalized.ok) return { ok: false, code: "store_failed" };
  const stored = await storeNormalizedChatImage(tenant_id, normalized.jpeg, run_id);
  if (!stored.ok) return { ok: false, code: "store_failed" };

  const { error: insErr } = await scoped
    .from(EXTENSION_SCREENSHOTS_TABLE)
    .insert({ user_id, image_path: stored.image_path, kind: "task_step", run_id });
  if (insErr) {
    await tenantStorage(asTenantId(tenant_id))
      .from(CHAT_IMAGE_BUCKET)
      .remove([stored.image_path])
      .catch(() => undefined);
    return { ok: false, code: "store_failed" };
  }
  const discard = async (code: "consent_required" | "store_failed"): Promise<TaskStepSaveResult> => {
    const removed = await Promise.resolve(
      tenantStorage(asTenantId(tenant_id)).from(CHAT_IMAGE_BUCKET).remove([stored.image_path]),
    ).catch((e: unknown) => ({ error: e }));
    if ((removed as { error?: unknown } | null)?.error) return { ok: false, code: "store_failed" };
    const unlinked = await Promise.resolve(
      scoped
        .from("run_artifacts")
        .delete()
        .eq("bucket", CHAT_IMAGE_BUCKET)
        .eq("storage_path", stored.image_path),
    ).catch((e: unknown) => ({ error: e }));
    if ((unlinked as { error?: unknown } | null)?.error) return { ok: false, code: "store_failed" };
    await Promise.resolve(
      scoped
        .from(EXTENSION_SCREENSHOTS_TABLE)
        .update({ deleted_at: new Date().toISOString() })
        .eq("user_id", user_id)
        .eq("image_path", stored.image_path),
    ).catch(() => undefined);
    return { ok: false, code };
  };

  if (!(await registerTaskStepArtifact(tenant_id, run_id, stored.image_path, normalized.jpeg.byteLength))) {
    return discard("store_failed");
  }

  const stillConsented = await hasCurrentExtensionConsent(tenant_id, user_id).catch(() => false);
  if (!stillConsented) return discard("consent_required");
  return { ok: true, image_path: stored.image_path };
}

export function taskStepArtifactFilename(image_path: string): string {
  const base = image_path.split("/").pop() ?? "";
  const id = base.replace(/\.jpg$/, "").replace(/[^a-z0-9]/g, "").slice(0, 12) || "step";
  return `tab-task-${id}.jpg`;
}

async function registerTaskStepArtifact(
  tenant_id: string,
  run_id: string,
  image_path: string,
  bytes: number,
): Promise<boolean> {
  const scoped = tenantClient(asTenantId(tenant_id));
  let agent_slug: string | null = null;
  let thread_id: string | null = null;
  try {
    const { data } = await scoped
      .from("agent_runs")
      .select("agent_slug, payload")
      .eq("id", run_id)
      .maybeSingle<{ agent_slug: string | null; payload: { thread_id?: unknown } | null }>();
    if (!data) return false;
    agent_slug = typeof data.agent_slug === "string" && data.agent_slug ? data.agent_slug : null;
    const t = data.payload?.thread_id;
    thread_id = typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
  } catch {
    return false;
  }
  const filename = taskStepArtifactFilename(image_path);
  try {
    const { error } = await scoped.from("run_artifacts").insert({
      run_id,
      storage_path: image_path,
      bucket: CHAT_IMAGE_BUCKET,
      filename,
      title: filename.replace(/\.[^.]+$/, ""),
      mime: "image/jpeg",
      bytes,
      agent_slug,
      thread_id,
      slack_delivered: true,
    });
    return !error;
  } catch {
    return false;
  }
}
