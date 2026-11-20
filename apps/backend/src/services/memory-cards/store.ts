
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";
import { contentHash } from "@/services/memory/content-hash";

export type CreateCardInput = {
  tenant_id: string;
  source_kind: "slack" | "meeting" | "email" | "doc";
  source_ref?: string;
  source_url?: string | null;
  title: string;
  body?: string;
  source_excerpt?: string;
  confidence?: "low" | "medium" | "high";
  requested_by_external?: string | null;
  slack_team_id?: string | null;
  slack_channel_id?: string | null;
  slack_thread_ts?: string | null;
};

export type CreateCardResult =
  | { ok: true; card_id: string; deduped: boolean }
  | { ok: false; reason: string };

export async function createCard(input: CreateCardInput): Promise<CreateCardResult> {
  const svc = serviceClient();
  const hash = contentHash(input.tenant_id, "memory_card", `${input.title}\n${input.body ?? ""}`);

  const { data: existing } = await svc
    .from("memory_cards")
    .select("id")
    .eq("tenant_id", input.tenant_id)
    .eq("content_hash", hash)
    .eq("status", "pending_review")
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, card_id: existing.id as string, deduped: true };

  const { data, error } = await svc
    .from("memory_cards")
    .insert({
      tenant_id: input.tenant_id,
      source_kind: input.source_kind,
      source_ref: input.source_ref ?? "",
      source_url: input.source_url ?? null,
      title: input.title,
      body: input.body ?? "",
      source_excerpt: input.source_excerpt ?? "",
      confidence: input.confidence ?? "medium",
      requested_by_external: input.requested_by_external ?? null,
      slack_team_id: input.slack_team_id ?? null,
      slack_channel_id: input.slack_channel_id ?? null,
      slack_thread_ts: input.slack_thread_ts ?? null,
      content_hash: hash,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error && /duplicate key|unique/i.test(error.message)) {
      return { ok: true, card_id: "", deduped: true };
    }
    return { ok: false, reason: error?.message ?? "insert_failed" };
  }
  return { ok: true, card_id: data.id as string, deduped: false };
}

export type DecideResult =
  | { ok: true; status: "approved" | "ignored"; changed: boolean; memory_note_id?: string }
  | { ok: false; code: "not_found" | "write_failed"; message: string };

export async function approveCard(args: {
  tenant_id: string;
  card_id: string;
  actor_user_id: string;
  title_override?: string;
  body_override?: string;
}): Promise<DecideResult> {
  const svc = serviceClient();
  const { data: card, error } = await svc
    .from("memory_cards")
    .select("id, tenant_id, status, source_kind, source_ref, title, body, source_excerpt, slack_thread_ts")
    .eq("id", args.card_id)
    .eq("tenant_id", args.tenant_id)
    .maybeSingle();
  if (error || !card) return { ok: false, code: "not_found", message: "card not found" };
  if (card.status === "approved") return { ok: true, status: "approved", changed: false };
  if (card.status === "ignored") return { ok: false, code: "not_found", message: "card already ignored" };

  const title = (args.title_override ?? (card.title as string)).slice(0, 200);
  const body = args.body_override ?? (card.body as string) ?? "";
  const excerpt = (card.source_excerpt as string) ?? "";

  let memory_note_id: string;
  try {
    const r = await writeNote(args.tenant_id, {
      title,
      body_markdown: [body || title, excerpt ? `\n> ${excerpt}` : "", `\n(captured via Memory Inbox, reviewed + approved)`].join(""),
      note_type: "tenant_reference",
      source: "memory_card_distill",
      source_ref: `card:${card.id}`,
      tags: ["memory_card", String(card.source_kind)],
    });
    memory_note_id = r.note_id;
  } catch (e) {
    return { ok: false, code: "write_failed", message: (e as Error).message };
  }

  await svc
    .from("memory_cards")
    .update({
      status: "approved",
      memory_note_id,
      decided_by: args.actor_user_id,
      decided_at: new Date().toISOString(),
      ...(args.title_override ? { title } : {}),
      ...(args.body_override !== undefined ? { body } : {}),
    })
    .eq("id", card.id)
    .eq("status", "pending_review");

  return { ok: true, status: "approved", changed: true, memory_note_id };
}

export async function ignoreCard(args: {
  tenant_id: string;
  card_id: string;
  actor_user_id: string;
}): Promise<DecideResult> {
  const svc = serviceClient();
  const { data: card, error } = await svc
    .from("memory_cards")
    .select("id, status")
    .eq("id", args.card_id)
    .eq("tenant_id", args.tenant_id)
    .maybeSingle();
  if (error || !card) return { ok: false, code: "not_found", message: "card not found" };
  if (card.status !== "pending_review") {
    return { ok: true, status: "ignored", changed: false };
  }
  await svc
    .from("memory_cards")
    .update({ status: "ignored", decided_by: args.actor_user_id, decided_at: new Date().toISOString() })
    .eq("id", card.id)
    .eq("status", "pending_review");
  return { ok: true, status: "ignored", changed: true };
}
