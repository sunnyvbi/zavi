
import { serviceClient } from "@/services/supabase";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";

export async function deliverArtifactToThread(args: {
  tenant_id: string;
  thread_id: string;
  run_id: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const svc = serviceClient();
    const { data: thread, error: thErr } = await svc
      .from("agent_threads")
      .select("id")
      .eq("id", args.thread_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (thErr || !thread) {
      console.warn(
        `[deliver-artifact-to-thread] SKIPPED (thread=${args.thread_id}): ` +
          (thErr ? `lookup failed: ${thErr.message}` : "thread not found for tenant"),
      );
      return false;
    }
    const { error: insErr } = await svc.from("agent_thread_messages").insert({
      thread_id: args.thread_id,
      tenant_id: args.tenant_id,
      sender_role: "assistant",
      body: args.body,
      agent_run_id: null,
      meta: { artifact_delivery: true, source_run_id: args.run_id, ...(args.meta ?? {}) },
    });
    if (insErr) {
      console.warn(`[deliver-artifact-to-thread] insert FAILED (thread=${args.thread_id}): ${insErr.message}`);
      return false;
    }
    await svc
      .from("agent_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", args.thread_id);
    void notifyThreadOwner({
      tenant_id: args.tenant_id,
      thread_id: args.thread_id,
      agent_slug: "operator",
      body: "Zavi posted a new message.",
    }).catch(() => {});
    return true;
  } catch (e) {
    console.warn(`[deliver-artifact-to-thread] threw (thread=${args.thread_id}): ${(e as Error).message}`);
    return false;
  }
}
