
import { CHANNELS, type Channel } from "@zavi/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WatchVerdict } from "./watch";

export type ChannelWorkState = "idle" | "running" | "needs_review" | "delivered";

export const CHANNEL_STATE_COLUMNS =
  "channel_slug, work_state, priority, last_run_at, last_probe_at, last_probe_delta, " +
  "plan_selected, plan_selected_set_by, plan_sort_order, autorun, autorun_set_by, autorun_set_at, chatgpt_autopilot_consent_at";

export type ChannelState = {
  channel: Channel;
  work_state: ChannelWorkState;
  priority: number;
  plan_selected: boolean;
  plan_selected_set_by: string | null;
  plan_sort_order: number | null;
  autorun: boolean;
  autorun_set_by: string | null;
  autorun_set_at: string | null;
  chatgpt_autopilot_consent_at: string | null;
  last_run_at: string | null;
  last_probe_at: string | null;
  last_probe_delta: WatchVerdict | null;
  seeded: boolean;
};

const DEFAULTS = {
  work_state: "idle" as ChannelWorkState,
  priority: 100,
  plan_selected: false,
  plan_selected_set_by: null,
  plan_sort_order: null,
  autorun: false,
  autorun_set_by: null,
  autorun_set_at: null,
  chatgpt_autopilot_consent_at: null,
  last_run_at: null,
  last_probe_at: null,
  last_probe_delta: null,
};

type Row = {
  channel_slug: string;
  work_state?: ChannelWorkState | null;
  priority?: number | null;
  plan_selected?: boolean | null;
  plan_selected_set_by?: string | null;
  plan_sort_order?: number | null;
  autorun?: boolean | null;
  autorun_set_by?: string | null;
  autorun_set_at?: string | null;
  chatgpt_autopilot_consent_at?: string | null;
  last_run_at?: string | null;
  last_probe_at?: string | null;
  last_probe_delta?: WatchVerdict | null;
};

export function joinChannelStates(rows: readonly Row[]): ChannelState[] {
  const bySlug = new Map(rows.map((r) => [r.channel_slug, r]));
  return CHANNELS.map((channel) => {
    const row = bySlug.get(channel.slug);
    return {
      channel,
      work_state: row?.work_state ?? DEFAULTS.work_state,
      priority: row?.priority ?? DEFAULTS.priority,
      plan_selected: row?.plan_selected ?? DEFAULTS.plan_selected,
      plan_selected_set_by: row?.plan_selected_set_by ?? DEFAULTS.plan_selected_set_by,
      plan_sort_order: row?.plan_sort_order ?? DEFAULTS.plan_sort_order,
      autorun: row?.autorun ?? DEFAULTS.autorun,
      autorun_set_by: row?.autorun_set_by ?? DEFAULTS.autorun_set_by,
      autorun_set_at: row?.autorun_set_at ?? DEFAULTS.autorun_set_at,
      chatgpt_autopilot_consent_at: row?.chatgpt_autopilot_consent_at ?? DEFAULTS.chatgpt_autopilot_consent_at,
      last_run_at: row?.last_run_at ?? DEFAULTS.last_run_at,
      last_probe_at: row?.last_probe_at ?? DEFAULTS.last_probe_at,
      last_probe_delta: row?.last_probe_delta ?? DEFAULTS.last_probe_delta,
      seeded: row !== undefined,
    };
  });
}

export type ChannelStatesRead = {
  states: ChannelState[];
  rowCount: number;
  error: string | null;
};

export async function readChannelStates(
  client: SupabaseClient,
  tenant_id: string,
): Promise<ChannelStatesRead> {
  const { data, error } = await client
    .from("tenant_channels")
    .select(CHANNEL_STATE_COLUMNS)
    .eq("tenant_id", tenant_id);

  if (error) {
    return { states: joinChannelStates([]), rowCount: 0, error: error.message };
  }
  const rows = (data ?? []) as unknown as Row[];
  return { states: joinChannelStates(rows), rowCount: rows.length, error: null };
}
