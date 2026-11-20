
import { channelBudgetAllows, CAP_REACHED_MESSAGE } from "./budget";
import { comingSoonMessage, isChannelLocked } from "./lock";
import { reserveEstimateFor } from "@/services/agents/credits";
import { channelForAgent, listChannelAgents } from "@/services/agents/channel-agents";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { trackChannelRunStarted } from "@/services/analytics/action-events";
import { channelPlanLock } from "@/services/growth/preview-plan";
import { readChannelStopped } from "@/services/growth/channel-stopped";
import { RETIRED_CHANNEL_MESSAGE, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";

export type DirectChannelAdmission =
  | { allowed: true; channel_slug: string; estimate: number }
  | { allowed: false; reason: "coming_soon" | "retired" | "budget" | "founder_stopped"; message: string };

export function refusedHandoffPayload(
  admission: Extract<DirectChannelAdmission, { allowed: false }>,
): Record<string, string> {
  if (admission.reason === "retired") {
    return {
      error: "channel_retired",
      message: admission.message,
      next_step:
        "Do not hand off to this channel again. Answer the request yourself now with the read tools you already have, and say in one line that this channel was retired.",
    };
  }
  if (admission.reason === "founder_stopped") {
    return {
      error: "channel_stopped",
      message: admission.message,
      next_step:
        "Do not hand off to this channel again. Answer the request yourself with the read tools you already have, and say in one line that the founder stopped this channel.",
    };
  }
  if (admission.reason !== "coming_soon") {
    return { error: "channel_budget_exhausted", message: admission.message };
  }
  return {
    error: "coming_soon",
    message: admission.message,
    next_step:
      "Do not hand off to this channel again this turn. Answer the request yourself now with the read tools you already have, without asking permission, " +
      "and mention the channel is coming soon in at most one line.",
  };
}

export const RUN_FOR_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  generated_video: ["youtube_organic"],
};

async function admissionChannel(tenant_id: string, agent_slug: string, for_channel?: string) {
  const own = channelForAgent(agent_slug);
  const allowed = Object.prototype.hasOwnProperty.call(RUN_FOR_CHANNELS, agent_slug) ? RUN_FOR_CHANNELS[agent_slug] : [];
  if (!own || !for_channel || !allowed.includes(for_channel)) return own;
  const target = listChannelAgents().find((c) => c.channel_slug === for_channel);
  if (!target || (await channelPlanLock(tenant_id, for_channel)) !== null) return own;
  return target;
}

export async function admitDirectChannelRun(
  tenant_id: string,
  agent_slug: string,
  for_channel?: string,
  opts?: { chat?: boolean; accepted?: number },
): Promise<DirectChannelAdmission> {
  const channel = await admissionChannel(tenant_id, agent_slug, for_channel);
  if (!channel) {
    return { allowed: true, channel_slug: "", estimate: 0 };
  }
  if (RETIRED_CHANNEL_SLUGS.has(channel.channel_slug)) {
    return { allowed: false, reason: "retired", message: RETIRED_CHANNEL_MESSAGE };
  }
  if (await isChannelLocked(channel.channel_slug)) {
    return { allowed: false, reason: "coming_soon", message: comingSoonMessage(channel.name) };
  }
  if (!opts?.chat) {
    const stopped = await readChannelStopped(tenant_id, channel.channel_slug);
    if (stopped !== false) {
      return {
        allowed: false,
        reason: "founder_stopped",
        message: stopped
          ? `The founder stopped ${channel.name}, so Zavi does not run it.`
          : `Zavi could not check whether ${channel.name} was stopped, so it did not run it.`,
      };
    }
  }
  const estimate = reserveEstimateFor(agent_slug);
  if (opts?.chat) return { allowed: true, channel_slug: channel.channel_slug, estimate };
  const budget = await channelBudgetAllows(tenant_id, estimate + (opts?.accepted ?? 0));
  if (!budget.allowed) {
    return {
      allowed: false,
      reason: "budget",
      message:
        budget.reason === "cap_reached"
          ? CAP_REACHED_MESSAGE
          : "Couldn't check this channel's budget. Try again shortly.",
    };
  }
  return { allowed: true, channel_slug: channel.channel_slug, estimate };
}

export async function stampDirectChannelRun(
  tenant_id: string,
  run_id: string,
  channel_slug: string,
): Promise<boolean> {
  if (!channel_slug) return false;
  let stamped = false;
  for (let attempt = 1; attempt <= 2 && !stamped; attempt++) {
    try {
      const res = await tenantRpc(asTenantId(tenant_id), "stamp_channel_run", {
        p_run_id: run_id,
        p_channel_slug: channel_slug,
      });
      stamped = res.data === true;
    } catch {
    }
  }
  if (stamped) {
    trackChannelRunStarted({ tenant_id, channel_slug, path: "direct" });
    void (async () => {
      try {
        await tenantRpc(asTenantId(tenant_id), "record_channel_run", {
          p_run_id: run_id,
        });
      } catch {
      }
    })();
  }
  return stamped;
}

export async function stampDirectChannelRunWithin(
  tenant_id: string,
  run_id: string,
  channel_slug: string,
  ms = 1500,
): Promise<boolean | "timeout"> {
  const stamping = stampDirectChannelRun(tenant_id, run_id, channel_slug);
  stamping.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      stamping,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function healChatRunStamp(
  tenant_id: string,
  run_id: string,
  ms = 1500,
): Promise<string | null | "failed" | "unreadable"> {
  let timer: NodeJS.Timeout | undefined;
  const work = healChatRunStampUnbounded(tenant_id, run_id);
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<"unreadable">((resolve) => {
        timer = setTimeout(() => resolve("unreadable"), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function healChatRunStampUnbounded(
  tenant_id: string,
  run_id: string,
): Promise<string | null | "failed" | "unreadable"> {
  let row: { channel_slug?: string | null; agent_slug?: string | null; trigger?: string | null } | null;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("channel_slug, agent_slug, trigger")
      .eq("id", run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = data as typeof row;
  } catch (e) {
    console.warn(`[direct-run] run ${run_id} unreadable for stamp heal: ${(e as Error).message}`);
    return "unreadable";
  }
  if (row?.channel_slug) return row.channel_slug;
  const channel = row?.trigger === "chat" && row.agent_slug ? channelForAgent(row.agent_slug) : null;
  if (!channel) return null;

  try {
    const res = await tenantRpc(asTenantId(tenant_id), "stamp_channel_run", {
      p_run_id: run_id,
      p_channel_slug: channel.channel_slug,
    });
    if (res.data !== true) return "failed";
  } catch {
    return "failed";
  }
  console.info(JSON.stringify({ event: "channel_chat_stamp_healed", tenant_id, run_id, channel_slug: channel.channel_slug }));
  void (async () => {
    try {
      await tenantRpc(asTenantId(tenant_id), "record_channel_run", { p_run_id: run_id });
    } catch {
    }
  })();
  return channel.channel_slug;
}
