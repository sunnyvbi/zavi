
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export type PushKind = "agent_reply" | "approval" | "completion" | "result_milestone";

export type SendPushArgs = {
  tenant_id: string;
  kind: PushKind;
  agent_slug: string;
  thread_id: string | null;
  title: string;
  body: string;
  user_id?: string | null;
};

export type FanoutDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { from: (table: string) => any };
  fetchFn: typeof fetch;
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_SIZE = 100;

type DeviceRow = { user_id: string; expo_push_token: string };
type SettingsRow = {
  user_id: string;
  agent_replies: boolean;
  approvals: boolean;
  daily_brief: boolean;
};

function settingFor(kind: PushKind): keyof Omit<SettingsRow, "user_id"> {
  switch (kind) {
    case "approval":
      return "approvals";
    case "agent_reply":
    case "completion":
    case "result_milestone":
    default:
      return "agent_replies";
  }
}

export type FanoutResult = {
  sent: number;
  skipped_reason?: "flag_off" | "no_devices" | "no_eligible_users" | "no_owner" | "thread_deleted";
};

export async function sendPushForEvent(
  args: SendPushArgs,
  deps?: Partial<FanoutDeps>,
): Promise<FanoutResult> {
  const db = deps?.db ?? serviceClient();
  const fetchFn = deps?.fetchFn ?? fetch;

  let flagOn = false;
  try {
    const { data, error } = await db
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      return { sent: 0, skipped_reason: "flag_off" };
    }
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    flagOn = blob.push_notifications_enabled !== false;
  } catch {
    return { sent: 0, skipped_reason: "flag_off" };
  }
  if (!flagOn) {
    return { sent: 0, skipped_reason: "flag_off" };
  }

  if (!args.tenant_id) {
    return { sent: 0, skipped_reason: "no_devices" };
  }

  const ownerOnly = args.kind !== "approval";
  if (ownerOnly && !args.user_id) {
    return { sent: 0, skipped_reason: "no_owner" };
  }

  let deviceQuery = db
    .from("devices")
    .select("user_id, expo_push_token")
    .eq("tenant_id", args.tenant_id);
  if (ownerOnly) deviceQuery = deviceQuery.eq("user_id", args.user_id);
  const { data: deviceData, error: devErr } = await deviceQuery;
  if (devErr) {
    await safeLog("push.fanout.devices_read_failed", args.tenant_id);
    return { sent: 0, skipped_reason: "no_devices" };
  }
  const devices = (deviceData ?? []) as DeviceRow[];
  if (devices.length === 0) {
    return { sent: 0, skipped_reason: "no_devices" };
  }

  const userIds = Array.from(new Set(devices.map((d) => d.user_id)));
  const { data: settingsData, error: setErr } = await db
    .from("notification_settings")
    .select("user_id, agent_replies, approvals, daily_brief")
    .eq("tenant_id", args.tenant_id)
    .in("user_id", userIds);
  if (setErr) {
    await safeLog("push.fanout.settings_read_failed", args.tenant_id);
    return { sent: 0, skipped_reason: "no_eligible_users" };
  }
  const settingsByUser = new Map<string, SettingsRow>();
  for (const s of (settingsData ?? []) as SettingsRow[]) {
    settingsByUser.set(s.user_id, s);
  }

  const col = settingFor(args.kind);
  const eligibleTokens: string[] = [];
  for (const d of devices) {
    const s = settingsByUser.get(d.user_id);
    const enabled = s ? s[col] === true : true;
    if (enabled) eligibleTokens.push(d.expo_push_token);
  }
  if (eligibleTokens.length === 0) {
    return { sent: 0, skipped_reason: "no_eligible_users" };
  }

  const data = {
    type: args.kind,
    agent_slug: args.agent_slug,
    thread_id: args.thread_id,
  };
  let sent = 0;
  for (let i = 0; i < eligibleTokens.length; i += EXPO_BATCH_SIZE) {
    const batch = eligibleTokens.slice(i, i + EXPO_BATCH_SIZE);
    const messages = batch.map((to) => ({
      to,
      title: args.title,
      body: args.body,
      data,
      sound: "default",
      priority: "high",
    }));
    try {
      const resp = await fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });
      if (!resp.ok) {
        await safeLog("push.fanout.expo_http_error", args.tenant_id, resp.status);
        continue;
      }
      const tickets = await readTickets(resp);
      if (!tickets) {
        sent += batch.length;
        continue;
      }
      const dead: string[] = [];
      tickets.forEach((t, j) => {
        if (t?.status === "ok") {
          sent += 1;
          return;
        }
        const code = t?.details?.error ?? "unknown";
        void safeLog(`push.fanout.ticket_error.${code}`, args.tenant_id);
        if (code === "DeviceNotRegistered" && batch[j]) dead.push(batch[j]);
      });
      if (dead.length > 0) {
        try {
          await db.from("devices").delete().in("expo_push_token", dead);
        } catch {
          await safeLog("push.fanout.dead_token_delete_failed", args.tenant_id);
        }
      }
    } catch {
      await safeLog("push.fanout.expo_send_failed", args.tenant_id);
    }
  }

  return { sent };
}

type ExpoTicket = { status?: string; details?: { error?: string } };

async function readTickets(resp: Response): Promise<ExpoTicket[] | null> {
  try {
    const json = (await resp.json()) as { data?: unknown };
    return Array.isArray(json?.data) ? (json.data as ExpoTicket[]) : null;
  } catch {
    return null;
  }
}

async function safeLog(
  code: string,
  tenant_id: string,
  httpStatus?: number,
): Promise<void> {
  try {
    await logEvent({
      level: "warn",
      source: "push-fanout",
      code,
      tenant_id,
      meta: httpStatus !== undefined ? { http_status: httpStatus } : undefined,
    });
  } catch {
  }
}

export async function threadInfo(
  tenant_id: string,
  thread_id: string | null,
  deps?: Partial<FanoutDeps>,
): Promise<{ user_id: string | null; agent_slug: string | null; deleted: boolean } | null> {
  if (!thread_id) return null;
  try {
    const db = deps?.db ?? serviceClient();
    const { data } = await db
      .from("agent_threads")
      .select("user_id, agent_slug, deleted_at")
      .eq("id", thread_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (!data) return null;
    return {
      user_id: (data.user_id as string | null | undefined) ?? null,
      agent_slug: (data.agent_slug as string | null | undefined) ?? null,
      deleted: data.deleted_at != null,
    };
  } catch {
    return null;
  }
}

export async function notifyThreadOwner(
  args: {
    tenant_id: string;
    thread_id: string | null;
    agent_slug: string;
    body: string;
    title?: string;
  },
  deps?: Partial<FanoutDeps>,
): Promise<FanoutResult> {
  try {
    const thread = await threadInfo(args.tenant_id, args.thread_id, deps);
    if (thread?.deleted) return { sent: 0, skipped_reason: "thread_deleted" };
    return await sendPushForEvent(
      {
        tenant_id: args.tenant_id,
        kind: "agent_reply",
        agent_slug: thread?.agent_slug ?? args.agent_slug,
        thread_id: args.thread_id,
        title: args.title ?? "Zavi",
        body: args.body,
        user_id: thread?.user_id ?? null,
      },
      deps,
    );
  } catch {
    return { sent: 0, skipped_reason: "no_eligible_users" };
  }
}
