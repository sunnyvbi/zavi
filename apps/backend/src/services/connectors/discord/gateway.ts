
/* eslint-disable @typescript-eslint/no-explicit-any */

import crypto from "node:crypto";
import { oauthCallbackClient } from "@/services/tenant-client";
import { ingestAndEnqueueWorkItem } from "@/services/agents/work-queue";
import { discordEnabled, discordEnv, callDiscord } from "./adapter";
import { sanitizeDiscordMessagePayload } from "@/services/redactor/discord-payload-sanitizer";
import {
  INTAKE_FAILED_TEXT,
  MEDIA_UNSUPPORTED_TEXT,
  DISCORD_DM_TEXT,
  DISCORD_ROLE_MENTION_TEXT,
} from "@/services/connectors/chat-copy";
import { logEvent } from "@/services/logging/logEvent";

const SETTINGS_URL = "https://www.zaviagent.com/workspace?tab=settings";

const NOTICE_COOLDOWN_MS = 60_000;
const _noticeAt = new Map<string, number>();

function postNotice(channelId: string, content: string): void {
  const now = Date.now();
  if (now - (_noticeAt.get(channelId) ?? 0) < NOTICE_COOLDOWN_MS) return;
  _noticeAt.set(channelId, now);
  void callDiscord("POST", `/channels/${channelId}/messages`, { content }).catch(() => {});
}

const LEASE_TTL_SECONDS = 60;
const LEASE_RENEW_MS = 20_000;
const LEASE_RETRY_MS = 15_000;

function svc() {
  return oauthCallbackClient(
    "discord gateway: pre-tenant guild resolve + link-token consume (tenant recovered from server-minted state, no Bearer session exists)",
  );
}

async function resolveTenant(guildId: string): Promise<string | null> {
  if (!guildId) return null;
  const { data, error } = await svc()
    .from("discord_guilds")
    .select("tenant_id, status")
    .eq("guild_id", guildId)
    .maybeSingle<{ tenant_id: string; status: string }>();
  if (error || !data || data.status !== "enabled") return null;
  return data.tenant_id;
}

async function handleGuildCreate(guild: any): Promise<void> {
  const guildId = String(guild?.id ?? "");
  if (!guildId) return;
  if (await resolveTenant(guildId)) return;

  const text =
    `👋 Thanks for adding Zavi. To connect this server: sign in at ${SETTINGS_URL} ` +
    `as a workspace owner/admin, hit "Connect Discord" to get a one-time code, ` +
    `then post \`@Zavi connect <code>\` in any channel here. When Discord ` +
    `suggests @Zavi, pick the one with the APP badge, not the Zavi role.`;
  const channelId = pickPostableChannelId(guild);
  if (!channelId) return;
  await callDiscord("POST", `/channels/${channelId}/messages`, { content: text }).catch(
    () => {},
  );
}

export function pickPostableChannelId(guild: any): string {
  const me = guild?.members?.me ?? null;
  const canPost = (ch: any): boolean => {
    if (Number(ch?.type) !== 0) return false;
    try {
      const perms = ch?.permissionsFor?.(me);
      return Boolean(perms?.has?.("SendMessages") && perms?.has?.("ViewChannel"));
    } catch {
      return false;
    }
  };
  const systemId = String(guild?.systemChannelId ?? "");
  if (systemId) {
    const sys = guild?.channels?.cache?.get?.(systemId);
    if (!sys || canPost(sys)) return systemId;
  }
  const cache = guild?.channels?.cache;
  const first =
    typeof cache?.find === "function" ? cache.find((ch: any) => canPost(ch)) : null;
  return String(first?.id ?? "");
}

async function handleConnectCommand(
  msg: GatewayMessage,
  guildName: string,
  token: string,
): Promise<void> {
  const { data: status, error } = await svc().rpc("consume_discord_link_token", {
    p_token: token,
    p_guild_id: msg.guild_id,
    p_guild_name: guildName.slice(0, 200) || null,
    p_discord_user_id: msg.author.id || null,
    p_discord_username: (msg.author.username ?? "").slice(0, 64) || null,
  });
  if (error) {
    console.warn("[discord/gateway] consume_discord_link_token failed:", error.message);
    void logEvent({
      level: "error",
      source: "discord/gateway",
      code: "discord.connect.consume_failed",
      message: error.message,
    }).catch(() => {});
    await callDiscord("POST", `/channels/${msg.channel_id}/messages`, {
      content:
        "Couldn't confirm the connection just now. Send the same command again in a minute. " +
        `If it then says the code is invalid, check ${SETTINGS_URL}: this server may already be connected.`,
    }).catch(() => {});
    return;
  }
  const text =
    String(status) === "ok"
      ? "✅ Connected. This server is now linked to your Zavi workspace — @mention me with a task to get started."
      : String(status) === "guild_already_bound"
        ? "This server is already connected to a different Zavi workspace."
        : String(status) === "tenant_already_bound"
          ? "Your Zavi workspace is already connected to a different Discord server. Disconnect that one first — a workspace links to one server."
          : `That code is invalid or has expired. Mint a fresh one at ${SETTINGS_URL} and try again.`;
  await callDiscord("POST", `/channels/${msg.channel_id}/messages`, { content: text }).catch(
    () => {},
  );
}

async function handleGuildDelete(guild: any): Promise<void> {
  const guildId = String(guild?.id ?? "");
  if (!guildId) return;
  await svc().rpc("unset_discord_connection", { p_guild_id: guildId });
}

type GatewayMessage = {
  id: string;
  guild_id: string;
  guild_name?: string;
  channel_id: string;
  content: string;
  author: { id: string; bot: boolean; username?: string };
  mentions_bot: boolean;
  mentions_bot_role: boolean;
  is_reply_to_bot: boolean;
  attachment_count: number;
};

export function projectGatewayMessage(m: any, botId: string): GatewayMessage {
  const botRoleId = String((botId && m?.guild?.roles?.botRoleFor?.(botId)?.id) ?? "");
  return {
    id: String(m?.id ?? ""),
    guild_id: String(m?.guildId ?? ""),
    guild_name: String(m?.guild?.name ?? ""),
    channel_id: String(m?.channelId ?? ""),
    content: String(m?.content ?? ""),
    author: {
      id: String(m?.author?.id ?? ""),
      bot: Boolean(m?.author?.bot),
      username: typeof m?.author?.username === "string" ? m.author.username : undefined,
    },
    mentions_bot: Boolean(botId && m?.mentions?.users?.has?.(botId)),
    mentions_bot_role: Boolean(botRoleId && m?.mentions?.roles?.has?.(botRoleId)),
    is_reply_to_bot:
      Boolean(m?.reference) &&
      String(m?.mentions?.repliedUser?.id ?? "") === botId &&
      botId !== "",
    attachment_count:
      Number(m?.attachments?.size ?? 0) + Number(m?.stickers?.size ?? 0),
  };
}

export function stripMentions(content: string): string {
  return content.replace(/<@!?\d+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function handleDiscordMessage(msg: GatewayMessage): Promise<void> {
  if (_stopping) return;
  if (msg.author.bot) return;
  if (!msg.guild_id) {
    postNotice(msg.channel_id, DISCORD_DM_TEXT);
    return;
  }
  if (!msg.mentions_bot && !msg.is_reply_to_bot) {
    if (msg.mentions_bot_role) postNotice(msg.channel_id, DISCORD_ROLE_MENTION_TEXT);
    return;
  }

  const taskText = stripMentions(msg.content);

  const connect = taskText.match(/^connect\s+([A-Za-z0-9_-]{16,64})\s*$/i);
  if (connect) {
    await handleConnectCommand(msg, msg.guild_name ?? "", connect[1]);
    return;
  }

  const tenantId = await resolveTenant(msg.guild_id);
  if (!tenantId) return;

  const sanitized = sanitizeDiscordMessagePayload({
    id: msg.id,
    guild_id: msg.guild_id,
    channel_id: msg.channel_id,
    content: msg.content,
    author: msg.author,
  }) as Record<string, unknown>;

  if (!taskText) {
    if (msg.attachment_count > 0) {
      void callDiscord("POST", `/channels/${msg.channel_id}/messages`, {
        content: MEDIA_UNSUPPORTED_TEXT,
        message_reference: { message_id: msg.id, fail_if_not_exists: false },
      }).catch(() => {});
    }
    return;
  }

  const routing = {
    guild_id: msg.guild_id,
    channel_id: msg.channel_id,
    message_id: msg.id,
    text: taskText,
    from_user_id: msg.author.id || null,
    from_username: msg.author.username ?? null,
  };

  let result: Awaited<ReturnType<typeof ingestAndEnqueueWorkItem>>;
  try {
    result = await ingestAndEnqueueWorkItem({
      tenant_id: tenantId,
      provider: "discord",
      external_event_id: msg.id,
      event_type: "message",
      ingest_payload: sanitized,
      agent_slug: "operator",
      source: "webhook_discord",
      payload: { event_type: "message", discord: routing },
      dedupe_key: `discord:${msg.id}`,
    });
  } catch (e) {
    console.warn(`[discord/gateway] intake failed: ${(e as Error).message}`);
    void callDiscord("POST", `/channels/${msg.channel_id}/messages`, {
      content: INTAKE_FAILED_TEXT,
      message_reference: { message_id: msg.id, fail_if_not_exists: false },
    }).catch(() => {});
    return;
  }
  if (result.duplicate) return;

  void callDiscord(
    "PUT",
    `/channels/${msg.channel_id}/messages/${msg.id}/reactions/${encodeURIComponent("👀")}/@me`,
  ).catch(() => {});
}

const DISCORD_JS_MODULE = "discord.js";
async function loadDiscordJs(): Promise<any> {
  return import(DISCORD_JS_MODULE);
}

let _client: any | null = null;
let _stopping = false;
const _holder = `gw-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
let _renewTimer: NodeJS.Timeout | null = null;
let _retryTimer: NodeJS.Timeout | null = null;

async function claimLease(): Promise<boolean> {
  const { data, error } = await svc().rpc("claim_discord_gateway_lease", {
    p_holder: _holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  return !error && data === true;
}

async function connectClient(): Promise<void> {
  const dj: any = await loadDiscordJs();
  const client = new dj.Client({
    intents: [
      dj.GatewayIntentBits.Guilds,
      dj.GatewayIntentBits.GuildMessages,
      dj.GatewayIntentBits.DirectMessages,
    ],
    partials: [dj.Partials.Channel],
  });

  client.on("guildCreate", (g: any) => void handleGuildCreate(g).catch(() => {}));
  client.on("guildDelete", (g: any) => void handleGuildDelete(g).catch(() => {}));
  client.on("messageCreate", (m: any) => {
    void handleDiscordMessage(projectGatewayMessage(m, String(client.user?.id ?? ""))).catch(
      (e) => console.warn(`[discord/gateway] message handler error: ${(e as Error).message}`),
    );
  });
  client.on("error", (e: any) =>
    console.warn(`[discord/gateway] client error: ${e?.message ?? e}`),
  );

  await client.login(discordEnv()!.botToken);
  _client = client;
  console.log("[discord/gateway] connected");

  _renewTimer = setInterval(() => {
    void claimLease().then((ok) => {
      if (!ok && !_stopping) {
        console.warn("[discord/gateway] lease lost — disconnecting this session");
        void logEvent({
          level: "warn",
          source: "discord/gateway",
          code: "discord.gateway.lease_lost",
          message: `holder ${_holder} lost the gateway lease; disconnecting`,
        }).catch(() => {});
        void teardownClient().then(() => scheduleClaimRetry());
      }
    });
  }, LEASE_RENEW_MS);
  _renewTimer.unref?.();
}

async function teardownClient(): Promise<void> {
  if (_renewTimer) {
    clearInterval(_renewTimer);
    _renewTimer = null;
  }
  const c = _client;
  _client = null;
  if (c) {
    try {
      await c.destroy();
    } catch {
    }
  }
}

function scheduleClaimRetry(): void {
  if (_stopping || _retryTimer) return;
  _retryTimer = setInterval(() => {
    void claimLease().then((ok) => {
      if (!ok || _stopping) return;
      if (_retryTimer) {
        clearInterval(_retryTimer);
        _retryTimer = null;
      }
      void connectClient().catch((e) => {
        console.error(`[discord/gateway] connect after lease claim failed: ${e.message}`);
        scheduleClaimRetry();
      });
    });
  }, LEASE_RETRY_MS);
  _retryTimer.unref?.();
}

export async function startDiscordGateway(): Promise<{ started: boolean }> {
  if (!discordEnabled()) return { started: false };
  if (_client) return { started: true };
  _stopping = false;
  try {
    if (!(await claimLease())) {
      console.log("[discord/gateway] lease held elsewhere — will retry in background");
      scheduleClaimRetry();
      return { started: false };
    }
    await connectClient();
    return { started: true };
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[discord/gateway] failed to start (surface stays off): ${message}`);
    await logEvent({
      level: "error",
      source: "discord/gateway",
      code: "discord.gateway.start_failed",
      message: `discord gateway start failed (surface dead until fixed): ${message}`,
    }).catch(() => {});
    return { started: false };
  }
}

export async function stopDiscordGateway(): Promise<void> {
  _stopping = true;
  if (_retryTimer) {
    clearInterval(_retryTimer);
    _retryTimer = null;
  }
  const hadClient = Boolean(_client);
  await teardownClient();
  if (hadClient) {
    await svc().rpc("release_discord_gateway_lease", { p_holder: _holder });
    console.log("[discord/gateway] stopped + lease released");
  }
}

export const __testing = {
  setStopping(v: boolean) {
    _stopping = v;
  },
  holder(): string {
    return _holder;
  },
};
