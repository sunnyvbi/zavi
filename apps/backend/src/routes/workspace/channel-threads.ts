
import type { Request, Response } from "express";
import { adCardTitle, getChannel, isChannelSlug } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const LIMIT = 30;
const PREVIEW_CHARS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  channel_action_id: string | null;
};

export type ChannelThread = {
  id: string;
  title: string | null;
  preview: string | null;
  last_message_at: string | null;
  channel_action_id: string | null;
  card_title: string | null;
};

export async function workspaceListChannelThreads(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const channel = typeof req.query.channel === "string" ? req.query.channel : "";
  if (!isChannelSlug(channel)) {
    res.status(400).json({ error: { code: "validation", message: "unknown channel" } });
    return;
  }
  const rawAction = req.query.action;
  let action: string | null = null;
  if (rawAction !== undefined) {
    if (typeof rawAction !== "string" || !UUID_RE.test(rawAction)) {
      res.json({ threads: [] });
      return;
    }
    action = rawAction.toLowerCase();
  }

  const executor = getChannel(channel)?.executor;
  if (!executor) {
    res.json({ threads: [] });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  let query = supabase
    .from("agent_threads")
    .select("id, title, last_message_at, channel_action_id")
    .eq("user_id", auth.user_id)
    .eq("tenant_id", auth.tenant_id)
    .eq("agent_slug", executor)
    .eq("channel_slug", channel);
  if (action) query = query.eq("channel_action_id", action);
  const { data, error } = await query
    .is("deleted_at", null)
    .not("synthetic", "is", true)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  if (error) {
    res.status(500).json({ error: { code: "query_failed", message: error.message } });
    return;
  }
  const rows = (data ?? []) as Row[];

  const previewById = new Map<string, string>();
  const loadPreviews = Promise.all(
    rows.map(async (t) => {
      const { data: msg } = await supabase
        .from("agent_thread_messages")
        .select("body")
        .eq("thread_id", t.id)
        .eq("tenant_id", auth.tenant_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const body = (msg as { body: string | null } | null)?.body;
      if (body) previewById.set(t.id, body.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS));
    }),
  );

  const cardIds = [...new Set(rows.map((t) => t.channel_action_id).filter((v): v is string => !!v))];
  const titleById = new Map<string, string>();
  const loadTitles = (async () => {
    if (cardIds.length === 0) return;
    const { data: cards, error: cardErr } = await tenantClient(asTenantId(auth.tenant_id))
      .from("channel_actions")
      .select("id, title, exec_class, exec_payload")
      .in("id", cardIds);
    if (cardErr) return;
    for (const c of (cards ?? []) as Array<{ id: string; title: string | null; exec_class?: string | null; exec_payload?: unknown }>) {
      const t = adCardTitle(c);
      if (t) titleById.set(c.id, t);
    }
  })();

  await Promise.all([loadPreviews, loadTitles]);

  const threads: ChannelThread[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    preview: previewById.get(t.id) ?? null,
    last_message_at: t.last_message_at,
    channel_action_id: t.channel_action_id,
    card_title: t.channel_action_id ? titleById.get(t.channel_action_id) ?? null : null,
  }));
  res.json({ threads });
}
