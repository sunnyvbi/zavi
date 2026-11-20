
import { inngest } from "@/../workers/client";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { classifyFollowUp, type FollowUpKind } from "./follow-up";
import { teamNoteFingerprint, type CodeSignal } from "./signals";

type Row = { id: string; sender_role: string; body: string | null; agent_run_id: string | null; meta?: Record<string, unknown> | null };

const KIND_EVENT: Record<FollowUpKind, { source: "correction" | "rephrase"; signal: CodeSignal }> = {
  correction: { source: "correction", signal: "founder_correction" },
  frustration: { source: "correction", signal: "founder_frustration" },
  rephrase: { source: "rephrase", signal: "founder_rephrase" },
};

const PLACEHOLDER_FP = (signal: string) =>
  teamNoteFingerprint({ agentSlug: "", signal, tool: null, errorCode: null, failureShape: null });

async function emit(data: {
  run_id: string; source: "correction" | "rephrase" | "edit"; signal: CodeSignal;
  correction_message_id: string; edited_message_id?: string;
}): Promise<void> {
  await inngest.send({
    name: "team_note.candidate",
    data: {
      run_id: data.run_id,
      source: data.source,
      signals: [data.signal],
      fingerprint: PLACEHOLDER_FP(data.signal),
      correction_message_id: data.correction_message_id,
      ...(data.edited_message_id ? { edited_message_id: data.edited_message_id } : {}),
    },
  });
}

export async function flagPreviousReply(args: {
  tenantId: string;
  threadId: string;
  newUserMessageId: string;
  text: string;
  inFlightRunId?: string;
  editOfMessageId?: string;
}): Promise<void> {
  try {
    if (!(await getBoolSetting("team_note_enabled", args.tenantId))) return;
    const db = tenantClient(asTenantId(args.tenantId));

    if (args.editOfMessageId) {
      const { data: orig } = await db.from("agent_thread_messages")
        .select("id, sender_role, thread_id, created_at")
        .eq("id", args.editOfMessageId)
        .eq("thread_id", args.threadId)
        .maybeSingle();
      const o = orig as { sender_role: string; created_at: string } | null;
      if (!o || o.sender_role !== "user") return;
      const { data: after } = await db.from("agent_thread_messages")
        .select("id, sender_role, agent_run_id, meta")
        .eq("thread_id", args.threadId)
        .gt("created_at", o.created_at)
        .order("created_at", { ascending: true })
        .limit(4);
      const reply = ((after ?? []) as Row[]).find((r) => r.sender_role === "assistant" && !!r.agent_run_id);
      if (!reply || reply.meta?.stopped === true) return;
      await emit({
        run_id: reply.agent_run_id as string, source: "edit", signal: "founder_edit",
        correction_message_id: args.newUserMessageId, edited_message_id: args.editOfMessageId,
      });
      return;
    }

    const { data } = await db.from("agent_thread_messages")
      .select("id, sender_role, body, agent_run_id")
      .eq("thread_id", args.threadId)
      .filter("meta->>superseded_by", "is", null)
      .order("created_at", { ascending: false })
      .limit(8);
    const rows = ((data ?? []) as Row[]).filter((r) => r.id !== args.newUserMessageId);

    if (args.inFlightRunId) {
      const prevUser = rows.find((r) => r.sender_role === "user") ?? null;
      const kind = classifyFollowUp({
        next: args.text, prevUser: prevUser?.body ?? null, prevReply: null,
        rephraseSimilarity: 1, allowRephrase: false,
      });
      if (kind !== "correction" && kind !== "frustration") return;
      await emit({ run_id: args.inFlightRunId, ...KIND_EVENT[kind], correction_message_id: args.newUserMessageId });
      return;
    }

    const replyIdx = rows.findIndex((r) => r.sender_role === "assistant" && !!r.agent_run_id);
    if (replyIdx < 0) return;
    if (rows.slice(0, replyIdx).some((r) => r.sender_role === "user")) return;
    const reply = rows[replyIdx];
    const prevUser = rows.slice(replyIdx + 1).find((r) => r.sender_role === "user") ?? null;
    const kind = classifyFollowUp({
      next: args.text,
      prevUser: prevUser?.body ?? null,
      prevReply: reply.body,
      rephraseSimilarity: await getNumberSetting("team_note_rephrase_similarity", args.tenantId),
      allowRephrase: true,
    });
    if (!kind) return;
    await emit({
      run_id: reply.agent_run_id as string,
      ...KIND_EVENT[kind],
      correction_message_id: args.newUserMessageId,
    });
  } catch (e) {
    console.warn(`[team-note] follow-up check skipped: ${(e as Error).message}`);
  }
}
