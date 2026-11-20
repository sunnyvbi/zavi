
import { aliasDomain, isAliasEmail } from "./alias";
import { confirmLink } from "./broker";
import type { MailKind, SiteAuthDirectory, SiteMailer } from "./types";
import { verifyStandardWebhook } from "./webhook-signature";

export interface HookDeps {
  directory: SiteAuthDirectory;
  mailer: SiteMailer;
  now: () => number;
  log?: (msg: string) => void;
}

export interface HookResult {
  status: number;
  body: Record<string, unknown>;
}

const KIND: Record<string, MailKind> = {
  magiclink: "magic_link",
  recovery: "recovery",
  invite: "invite",
  email: "email_otp",
};

const fail = (status: number, message: string): HookResult => ({
  status,
  body: { error: { http_code: status, message } },
});

export async function handleSendEmailHook(
  deps: HookDeps,
  shardId: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: Buffer,
): Promise<HookResult> {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(shardId)) return fail(401, "unauthorized");
  const shard = await deps.directory.shard(shardId);
  if (!shard || !shard.hookSecret) return fail(401, "unauthorized");
  if (!verifyStandardWebhook(shard.hookSecret, headers, rawBody, deps.now())) return fail(401, "unauthorized");

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return fail(400, "bad_payload");
  }
  const userId = payload?.user?.id;
  const aliasEmail = typeof payload?.user?.email === "string" ? payload.user.email.toLowerCase() : "";
  const action = payload?.email_data?.email_action_type;
  const tokenHash = payload?.email_data?.token_hash;
  if (typeof userId !== "string" || typeof action !== "string") return fail(400, "bad_payload");

  const kind = KIND[action];
  if (!kind) {
    deps.log?.(`[site-auth hook] refused action ${action} on shard ${shardId}`);
    return fail(403, "action_not_allowed");
  }
  if (typeof tokenHash !== "string" || !/^[A-Za-z0-9_\-.=]{8,512}$/.test(tokenHash)) return fail(400, "bad_payload");
  if (!isAliasEmail(aliasEmail, aliasDomain())) return fail(403, "recipient_not_allowed");

  const rows = await shard.store.resolveAlias(aliasEmail);
  const row = rows.find((r) => r.kind === "current" && r.authUserId === userId);
  if (!row || row.state === "deleting") return fail(403, "recipient_not_allowed");

  const site = await deps.directory.site(row.siteId);
  if (!site || !site.active || site.shardId !== shardId) return fail(403, "site_unavailable");

  const link = confirmLink(site.hostname, action, tokenHash);
  const sent = await deps.mailer.send(shard.store, { site, to: row.emailNorm, kind, link });
  if (sent === "limited") return fail(429, "rate_limited");
  return { status: 200, body: {} };
}
