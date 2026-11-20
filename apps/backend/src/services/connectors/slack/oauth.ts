
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";

export const BOT_SCOPES_VERSION = 6 as const;

const BOT_SCOPES = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "users:read",
  "users:read.email",
  "app_mentions:read",
  "chat:write",
  "reactions:write",
  "files:write",
  "channels:join",
  "pins:read",
  "files:read",
  "usergroups:read",
  "team:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "channels:manage",
] as const;

function clientCreds(): { id: string; secret: string } {
  const id = process.env.SLACK_CLIENT_ID;
  const secret = process.env.SLACK_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set. Register a Slack " +
        "app at https://api.slack.com/apps and stash the creds in .env.local.",
    );
  }
  return { id, secret };
}

function callbackUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL;
  if (!base) {
    throw new Error(
      "BACKEND_PUBLIC_URL must be set so Slack can reach the callback. For " +
        "local dev: `ngrok http 3001` and set BACKEND_PUBLIC_URL to the https URL.",
    );
  }
  return `${base.replace(/\/$/, "")}/api/connectors/slack/callback`;
}

export function slackOAuthStartUrl(state: string): string {
  const { id } = clientCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", id);
  u.searchParams.set("scope", BOT_SCOPES.join(","));
  u.searchParams.set("redirect_uri", callbackUrl());
  u.searchParams.set("state", state);
  return u.toString();
}

export type SlackOAuthExchange = {
  access_token: string;
  team_id: string;
  team_name: string;
  bot_user_id: string;
  scope: string;
  authed_user_id: string;
};

export async function exchangeCode(code: string): Promise<SlackOAuthExchange> {
  const { id, secret } = clientCreds();
  const body = new URLSearchParams({
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: callbackUrl(),
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Slack oauth.v2.access HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`Slack oauth.v2.access not ok: ${String(json.error ?? "unknown")}`);
  }
  const team = json.team as { id?: string; name?: string } | undefined;
  const authedUser = json.authed_user as { id?: string } | undefined;
  return {
    access_token: String(json.access_token ?? ""),
    team_id: String(team?.id ?? ""),
    team_name: String(team?.name ?? ""),
    bot_user_id: String(json.bot_user_id ?? ""),
    scope: String(json.scope ?? ""),
    authed_user_id: String(authedUser?.id ?? ""),
  };
}

export function botScopes(): readonly string[] {
  return BOT_SCOPES;
}

export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return BOT_SCOPES.filter((s) => !have.has(s));
}

const SCOPE_ADDITIONS_BY_VERSION: readonly (readonly string[])[] = [
  [
    "channels:read",
    "groups:read",
    "channels:history",
    "groups:history",
    "users:read",
    "users:read.email",
    "app_mentions:read",
    "chat:write",
    "reactions:write",
    "files:write",
  ],
  ["channels:join", "pins:read", "files:read", "usergroups:read", "team:read"],
  ["im:history", "im:read", "im:write"],
  ["mpim:history", "mpim:read"],
  ["mpim:write"],
  ["channels:manage"],
];

export function grantedScopesVersion(granted: readonly string[]): number {
  const have = new Set(granted);
  let version = 0;
  for (let v = 1; v <= SCOPE_ADDITIONS_BY_VERSION.length; v++) {
    if (SCOPE_ADDITIONS_BY_VERSION[v - 1].every((s) => have.has(s))) {
      version = v;
    } else {
      break;
    }
  }
  return version;
}
