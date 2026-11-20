
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseConfirmTurn } from "@/agents/qa/parse-confirm";
import { draftsSchema } from "@/agents/qa/drafts";
import { qaAddTestCase } from "@/services/mcp/internal/qa-engineer";

type DispatchArgs = {
  sb: SupabaseClient;
  tenantId: string;
  threadId: string;
  message: string;
};

export type ConfirmDispatchResult =
  | { handled: false }
  | {
      handled: true;
      action: "added" | "skipped" | "clarify" | "partial_error";
      added: number;
      duplicates: number;
    };

async function writeAssistant(
  sb: SupabaseClient,
  threadId: string,
  tenantId: string,
  body: string,
  category: string,
): Promise<void> {
  const { error: msgErr } = await sb.from("agent_thread_messages").insert({
    thread_id: threadId,
    tenant_id: tenantId,
    sender_role: "assistant",
    body,
    meta: { envelope_category: category },
    agent_run_id: null,
  });
  if (msgErr) {
    console.warn(
      `[qa-confirm] assistant bubble insert failed (thread ${threadId}): ${msgErr.message}`,
    );
  }
  await sb
    .from("agent_threads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", threadId);
}

export async function dispatchDeterministicConfirm(
  args: DispatchArgs,
): Promise<ConfirmDispatchResult> {
  const { sb, tenantId, threadId, message } = args;

  const { data: priorDraft } = await sb
    .from("agent_thread_messages")
    .select("id, agent_run_id, meta")
    .eq("thread_id", threadId)
    .eq("tenant_id", tenantId)
    .eq("sender_role", "assistant")
    .filter("meta->>envelope_category", "eq", "qa-chat-add-draft")
    .not("meta->drafts", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!priorDraft?.meta) return { handled: false };

  const draftsParse = draftsSchema.safeParse(
    (priorDraft.meta as { drafts?: unknown }).drafts,
  );
  if (!draftsParse.success) return { handled: false };
  const drafts = draftsParse.data;

  const intent = parseConfirmTurn(message);
  if (intent.kind === "unparsable") return { handled: false };

  const { error: userMsgErr } = await sb.from("agent_thread_messages").insert({
    thread_id: threadId,
    tenant_id: tenantId,
    sender_role: "user",
    body: message,
    agent_run_id: null,
  });
  if (userMsgErr) {
    console.warn(
      `[qa-confirm] user bubble insert failed (thread ${threadId}): ${userMsgErr.message}`,
    );
  }

  if (intent.kind === "skip") {
    await writeAssistant(
      sb,
      threadId,
      tenantId,
      "_No cases added._",
      "qa-chat-add-skipped",
    );
    return { handled: true, action: "skipped", added: 0, duplicates: 0 };
  }

  let chosen = drafts;
  if (intent.kind === "add_indices") {
    const max = drafts.length;
    const inRange = intent.indices.every((i) => i >= 1 && i <= max);
    if (!inRange) {
      const range = max > 1 ? `\`add 1\` through \`add ${max}\`` : "`add 1`";
      await writeAssistant(
        sb,
        threadId,
        tenantId,
        `I drafted ${max} case${max === 1 ? "" : "s"} — reply ${range}, \`add all\`, or \`skip\`.`,
        "qa-chat-add-clarify",
      );
      return { handled: true, action: "clarify", added: 0, duplicates: 0 };
    }
    chosen = intent.indices.map((i) => drafts[i - 1]);
  }

  const ctx = {
    tenant_id: tenantId,
    run_id: (priorDraft.agent_run_id as string | null) ?? "deterministic-confirm",
    agent_slug: "qa" as const,
  };

  let added = 0;
  const dupTitles: string[] = [];
  let hardError: Error | null = null;
  for (const d of chosen) {
    try {
      await qaAddTestCase(ctx, {
        title: d.title,
        role: d.role,
        nl_spec: d.nl_spec,
        tags: d.tags,
        created_by: "operator-chat",
      });
      added += 1;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const msg = (e as Error)?.message ?? "";
      if (code === "duplicate_title" || /duplicate_title/.test(msg)) {
        dupTitles.push(d.title);
      } else {
        hardError = e as Error;
        break;
      }
    }
  }

  if (hardError) {
    const partLines: string[] =
      added > 0
        ? [
            `Added **${added}** of ${chosen.length} test case${
              chosen.length === 1 ? "" : "s"
            } — then hit an error adding the rest. Please try again to add the remaining.`,
          ]
        : ["Couldn't add the cases — hit an error. Please try again."];
    await writeAssistant(
      sb,
      threadId,
      tenantId,
      partLines.join(" "),
      "qa-chat-add-partial-error",
    );
    console.warn(
      `[qa-confirm] partial_error after ${added}/${chosen.length} inserts (thread ${threadId}): ${hardError.message}`,
    );
    return {
      handled: true,
      action: "partial_error",
      added,
      duplicates: dupTitles.length,
    };
  }

  const lines: string[] = [];
  if (added > 0) {
    lines.push(`Added **${added}** test case${added === 1 ? "" : "s"} to your catalog.`);
  }
  if (dupTitles.length > 0) {
    lines.push(
      `Skipped ${dupTitles.length} already in the catalog: ${dupTitles
        .map((t) => `"${t}"`)
        .join(", ")}.`,
    );
  }
  if (lines.length === 0) lines.push("No cases added.");
  lines.push("\nReview them in /catalog.");

  await writeAssistant(
    sb,
    threadId,
    tenantId,
    lines.join(" "),
    "qa-chat-add-inserted",
  );
  return {
    handled: true,
    action: "added",
    added,
    duplicates: dupTitles.length,
  };
}
