
import { decisionHomeFromStamp, getChannel, isGrowthChannelSlug, type DecisionHome } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export function homePhrase(home: DecisionHome): string {
  if (home.kind === "channel") return `on the ${getChannel(home.slug)?.name ?? home.slug} channel page`;
  if (home.kind === "growth") return `under What needs you on the Your CGO page`;
  return "in the Needs you tab";
}

export type CardState = {
  table: "decisions" | "channel_actions";
  status: string | null;
  approved_by_source?: string | null;
  home: DecisionHome;
  in_chat: boolean;
  can_show_here?: boolean;
};

export function whereTheFounderApproves(s: CardState): string {
  const waiting = s.table === "decisions" ? s.status === "proposed" : s.status === "pending";
  if (!waiting) {
    return s.approved_by_source === "cgo"
      ? "Autopilot approved this change. There is no card for the founder to tap."
      : "This change is not waiting for the founder. There is no card to tap.";
  }
  const where = homePhrase(s.home);
  return s.in_chat
    ? `The founder approves it on the card shown in this chat. It is also listed ${where}.`
    : `The founder approves it on its card ${where}. No card was shown in this chat.${s.can_show_here ? " praxis__show_card with this id shows it here." : ""}`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function readCardState(
  tenant_id: string,
  id: string,
  table: "decisions" | "channel_actions",
  cardSince?: string,
  threadId?: string,
): Promise<CardState | null> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const inChat = async (): Promise<boolean | null> => {
      let q = db.from("thread_event").select("id").eq("tenant_id", tenant_id).eq("kind", "decision").eq("body->>decision_id", id);
      if (threadId) q = q.eq("thread_id", threadId);
      else if (cardSince) q = q.gte("created_at", cardSince);
      const r = await q.limit(1);
      return r.error ? null : ((r.data ?? []) as unknown[]).length > 0;
    };
    if (table === "channel_actions") {
      const { data, error } = await db
        .from("channel_actions")
        .select("status, channel_slug, approved_by_source")
        .eq("tenant_id", tenant_id)
        .eq("id", id)
        .maybeSingle();
      if (error || !data) return null;
      const r = data as { status?: string | null; channel_slug?: string | null; approved_by_source?: string | null };
      const in_chat = await inChat();
      if (in_chat === null) return null;
      return {
        table,
        status: r.status ?? null,
        approved_by_source: r.approved_by_source ?? null,
        home: isGrowthChannelSlug(r.channel_slug) ? { kind: "channel", slug: r.channel_slug as string } : { kind: "growth" },
        in_chat,
      };
    }
    const { data, error } = await db
      .from("decisions")
      .select("status, decision_class, home, home_channel, approved_by_source")
      .eq("tenant_id", tenant_id)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    const r = data as { status?: string | null; decision_class?: string; home?: string | null; home_channel?: string | null; approved_by_source?: string | null };
    const in_chat = await inChat();
    if (in_chat === null) return null;
    return {
      table,
      status: r.status ?? null,
      approved_by_source: r.approved_by_source ?? null,
      home: decisionHomeFromStamp({ decision_class: r.decision_class ?? "", home: r.home ?? null, home_channel: r.home_channel ?? null }),
      in_chat,
    };
  } catch {
    return null;
  }
}

export type CardChat = {
  run_id?: string;
  trigger?: string;
  writes_suppressed?: boolean;
};

export type CardLocationDeps = {
  read: typeof readCardState;
  target?: (tenant_id: string, run_id: string) => Promise<{ thread_id: string } | null>;
  attach?: (args: { tenant_id: string; run_id: string; card_id: string; table: "decisions" | "channel_actions" }) => Promise<unknown>;
  handOff?: (args: { tenant_id: string; run_id: string; card_id: string; decision_class: string; error: string; table: "decisions" | "channel_actions" }) => Promise<unknown>;
};

export async function withCardLocation(
  tenant_id: string,
  output: unknown,
  table: "decisions" | "channel_actions",
  callStartedAt?: string,
  depsOrRead: typeof readCardState | CardLocationDeps = readCardState,
  chat?: CardChat,
): Promise<unknown> {
  const o = obj(output);
  const id = o.decision_id;
  if (typeof id !== "string" || id.length === 0 || output !== o) return output;
  const deps: CardLocationDeps = typeof depsOrRead === "function" ? { read: depsOrRead } : depsOrRead;
  let threadId: string | undefined;
  if (chat?.trigger === "chat" && chat.run_id && !chat.writes_suppressed) {
    const runId = chat.run_id;
    try {
      const m = deps.target && deps.attach ? null : await import("./chat-card-attach");
      const target = deps.target ?? m!.chatCardTarget;
      const attach = deps.attach ?? m!.attachCardToChat;
      if (table === "channel_actions") {
        try {
          await attach({ tenant_id, run_id: runId, card_id: id, table });
        } catch (e) {
          const handOff = deps.handOff ?? (await import("./chat-card-delivery")).handOffChatCardDelivery;
          await handOff({ tenant_id, run_id: runId, card_id: id, decision_class: "channel.recipe_step", error: (e as Error).message, table });
        }
      }
      threadId = (await target(tenant_id, runId))?.thread_id;
    } catch {
      threadId = undefined;
    }
  }
  const state = await deps.read(tenant_id, id, table, callStartedAt, threadId);
  return state ? { ...o, where_the_founder_approves: whereTheFounderApproves({ ...state, can_show_here: !!threadId }) } : output;
}
