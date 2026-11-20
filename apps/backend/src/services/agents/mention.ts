
import { matchAgentMention, matchChannelMention } from "@zavi/shared";
import { CUSTOM_AGENT_SLUG_RE } from "@/services/billing/tiers";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { channelForAgent, type ChannelAgent } from "./channel-agents";

export type ChannelMention = {
  target: ChannelAgent;
  intent: string;
};

export function parseChannelMention(message: string): ChannelMention | null {
  const m = matchChannelMention(message ?? "");
  if (!m) return null;
  const target = channelForAgent(m.agent_slug);
  if (!target) return null;
  if (!m.rest) return null;
  return { target, intent: m.rest };
}

export type MentionTarget = {
  kind: "channel" | "agent" | "custom";
  agent_slug: string;
  intent: string;
};

const LEADING_TOKEN_RE = /^\s*@\s*([A-Za-z0-9-]+)(?=$|[\s:,.!?])/;

export async function isActiveCustomAgent(tenant_id: string, slug: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agents")
      .select("id")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle<{ id: string }>();
    return !error && !!data;
  } catch {
    return false;
  }
}

export async function resolveMention(
  message: string,
  tenant_id: string,
  deps: { isActiveCustom?: (tenant_id: string, slug: string) => Promise<boolean> } = {},
): Promise<MentionTarget | null> {
  const raw = message ?? "";
  const channel = parseChannelMention(raw);
  if (channel) return { kind: "channel", agent_slug: channel.target.agent_slug, intent: channel.intent };
  const agent = matchAgentMention(raw);
  if (agent) return agent.rest ? { kind: "agent", agent_slug: agent.agent_slug, intent: agent.rest } : null;
  const custom = LEADING_TOKEN_RE.exec(raw);
  if (!custom || !CUSTOM_AGENT_SLUG_RE.test(custom[1]!)) return null;
  const slug = custom[1]!;
  const intent = raw.slice(custom[0].length).replace(/^[\s:,]+/, "").trim();
  if (!intent) return null;
  const active = await (deps.isActiveCustom ?? isActiveCustomAgent)(tenant_id, slug);
  return active ? { kind: "custom", agent_slug: slug, intent } : null;
}

export type MentionPinDb = {
  from(table: "agent_runs"): {
    select(cols: string): {
      eq(c: string, v: string): { eq(c: string, v: string): { maybeSingle(): PromiseLike<{ data: { payload?: unknown } | null; error: { message: string } | null }> } };
    };
    update(row: Record<string, unknown>): {
      eq(c: string, v: string): { eq(c: string, v: string): PromiseLike<{ error: { message: string } | null }> };
    };
  };
};

export async function pinMentionOnRun(
  sb: MentionPinDb,
  tenant_id: string,
  run_id: string,
  mention: MentionTarget,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { data, error } = await sb.from("agent_runs").select("payload").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
    if (error || !data) return { ok: false, error: error?.message ?? "run row not found" };
    const prev = (data.payload as Record<string, unknown> | null) ?? {};
    const { error: upErr } = await sb
      .from("agent_runs")
      .update({ payload: { ...prev, mention_target: mention.agent_slug, mention_intent: mention.intent } })
      .eq("id", run_id)
      .eq("tenant_id", tenant_id);
    return upErr ? { ok: false, error: upErr.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
