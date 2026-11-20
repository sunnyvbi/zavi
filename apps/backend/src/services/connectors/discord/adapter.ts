
export type DiscordEnv = {
  botToken: string;
};

export function discordEnabled(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN);
}

export function discordEnv(): DiscordEnv | null {
  if (!discordEnabled()) return null;
  return { botToken: String(process.env.DISCORD_BOT_TOKEN) };
}

export function discordInstallUrl(): string | null {
  const clientId = String(process.env.DISCORD_CLIENT_ID ?? "").trim();
  if (!clientId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot&permissions=68672`;
}

const API_BASE = "https://discord.com/api/v10";

export type DiscordCallResult =
  | { ok: true; result: unknown }
  | { ok: false; disabled?: boolean; status?: number; error: string };

export async function callDiscord(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<DiscordCallResult> {
  const env = discordEnv();
  if (!env) return { ok: false, disabled: true, error: "discord_disabled" };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.botToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed =
      res.status === 204 ? null : ((await res.json().catch(() => null)) as unknown);
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === "object" && "message" in (parsed as object)
          ? String((parsed as { message: unknown }).message)
          : `discord_http_${res.status}`;
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, result: parsed };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type DiscordChannelGuild =
  | { kind: "guild"; guild_id: string }
  | { kind: "not_guild" }
  | { kind: "unknown"; error: string }
  | { kind: "bot_error"; error: string };

export async function lookupDiscordChannelGuild(channel_id: string): Promise<DiscordChannelGuild> {
  const id = String(channel_id ?? "").trim();
  if (!/^\d{5,25}$/.test(id)) return { kind: "not_guild" };
  const res = await callDiscord("GET", `/channels/${id}`);
  if (!res.ok) {
    if (res.disabled || res.status === 401) return { kind: "bot_error", error: res.error };
    if (res.status === 400 || res.status === 403 || res.status === 404) return { kind: "not_guild" };
    return { kind: "unknown", error: res.error };
  }
  const g = (res.result as { guild_id?: unknown } | null)?.guild_id;
  return typeof g === "string" && g.length > 0 ? { kind: "guild", guild_id: g } : { kind: "not_guild" };
}

export async function discordChannelGuildId(channel_id: string): Promise<string | null> {
  const r = await lookupDiscordChannelGuild(channel_id);
  return r.kind === "guild" ? r.guild_id : null;
}

export async function discordChannelMembership(
  channel_id: string,
  guild_id: string,
): Promise<"in" | "other" | "unknown" | "bot_error"> {
  if (!guild_id) return "other";
  const r = await lookupDiscordChannelGuild(channel_id);
  if (r.kind === "unknown" || r.kind === "bot_error") return r.kind;
  return r.kind === "guild" && r.guild_id === guild_id ? "in" : "other";
}

export async function discordChannelInGuild(channel_id: string, guild_id: string): Promise<boolean> {
  if (!guild_id) return false;
  return (await discordChannelGuildId(channel_id)) === guild_id;
}
