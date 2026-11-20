
import { SELF_REPORTED_LABEL, socialUrl } from "@zavi/shared";
import { sgSend } from "@/email/sendAuthEmail";
import { systemSender } from "@/email/system-identity";
import { renderInviteMessageEmail } from "@/email/templates/creator-invite-message";
import { logEvent } from "@/services/logging/logEvent";
import { resolveInviteEmailCap, type InviteEmailCap } from "@/services/agents/entitlement";
import { MAX_INVITE_EMAILS_PER_DAY } from "@/services/billing/tiers";
import { asTenantId, creatorAreaClient, creatorInviteRpc, globalClient, tenantClient } from "@/services/tenant-client";
import { classifySendError, inviteLinkBases } from "./creator-invites";
import { inviteSignInUrl, inviteUnsubscribeUrl } from "./creator-invite-send";
import { resolveBusinessName } from "./briefs-db";
import { scrubContact } from "./contact-scrub";
import { ensureCreatorThread } from "./thread";
import type { CreatorSocial } from "./creator-fields";

const INVITES = "creator_invites";
const MESSAGES = "creator_invite_messages";
const HANDLES = "human_member_handles";

const messagesOf = (tenantId: string) => tenantClient(asTenantId(tenantId)).from(MESSAGES);

export const INVITE_ID_PREFIX = "invite:";
export const NOT_ON_ZAVI_LABEL = "Not on Zavi yet";

export const MAX_MESSAGES_PER_INVITE = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isInviteUuid = (v: string): boolean => UUID_RE.test(v);

type ProfileLink = { url?: string | null; handle?: string | null };
type FollowerCount = { raw?: string | null; n?: number | null };

type InviteSearchRow = {
  id: string;
  display_name: string;
  profiles: Record<string, ProfileLink> | null;
  followers: Record<string, FollowerCount> | null;
  invited_at: string | null;
};

const SEARCH_COLUMNS = "id, display_name, profiles, followers, invited_at";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function visible(q: any): any {
  return q
    .not("invited_at", "is", null)
    .not("email", "is", null)
    .is("human_member_id", null)
    .is("claimed_at", null)
    .is("member_deleted_at", null)
    .is("unsubscribed_at", null)
    .is("bounced_at", null)
    .is("send_failed_at", null)
    .is("hold_reason", null);
}

export function inviteSocials(row: Pick<InviteSearchRow, "profiles" | "followers">): CreatorSocial[] {
  const out: CreatorSocial[] = [];
  for (const [platform, link] of Object.entries(row.profiles ?? {})) {
    const handle = (link?.handle ?? "").replace(/^@+/, "").trim();
    if (!handle) continue;
    const n = row.followers?.[platform]?.n;
    out.push({
      platform,
      handle,
      url: socialUrl(platform, handle),
      followers: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null,
      label: SELF_REPORTED_LABEL,
    });
  }
  return out;
}

export type InvitedCreatorResult = {
  human_member_id: string;
  invite_id: string;
  invited: true;
  status_label: string;
  slug: string;
  display_name: string;
  lanes: string[];
  niches: string[];
  platforms: string[];
  location: { city: string | null; country_code: string | null };
  bookable: false;
  not_bookable_message: string;
  self_reported_audience: [];
  handles: CreatorSocial[];
  packages: [];
  from_price_cents: null;
  from_price_business_total_cents: null;
  joined_at: null;
};

export const INVITED_NOTE = "Not on Zavi yet: they were invited but have not signed up. A message sends them an email to join and read it.";

function projectInvite(row: InviteSearchRow): InvitedCreatorResult {
  const handles = inviteSocials(row);
  return {
    human_member_id: `${INVITE_ID_PREFIX}${row.id}`,
    invite_id: row.id,
    invited: true,
    status_label: NOT_ON_ZAVI_LABEL,
    slug: "",
    display_name: row.display_name,
    lanes: [],
    niches: [],
    platforms: handles.map((h) => h.platform),
    location: { city: null, country_code: null },
    bookable: false,
    not_bookable_message: "Not on Zavi yet. Message them; they can be booked once they sign up.",
    self_reported_audience: [],
    handles,
    packages: [],
    from_price_cents: null,
    from_price_business_total_cents: null,
    joined_at: null,
  };
}

export type InviteSearchFilters = {
  order: "newest" | "a_to_z";
  lane: string | null;
  platform: string | null;
  needsMemberData: boolean;
  limit: number;
  offset: number;
};

function invitesCanMatch(f: Pick<InviteSearchFilters, "lane" | "platform" | "needsMemberData">): boolean {
  if (f.needsMemberData) return false;
  if (f.lane && f.lane !== "ugc_video") return false;
  return !f.platform || ["instagram", "x", "youtube"].includes(f.platform);
}

export async function countInvitedCreators(f: Pick<InviteSearchFilters, "lane" | "platform" | "needsMemberData">): Promise<number> {
  if (!invitesCanMatch(f)) return 0;
  let q = visible(globalClient().from(INVITES).select("id", { count: "exact", head: true }));
  if (f.platform) q = q.not(`profiles->${f.platform}`, "is", null);
  const { count, error } = await q;
  if (error) throw new Error(`creator_invites count failed: ${error.message}`);
  return count ?? 0;
}

export async function searchInvitedCreators(f: InviteSearchFilters): Promise<InvitedCreatorResult[]> {
  if (!invitesCanMatch(f)) return [];
  let q = visible(globalClient().from(INVITES).select(SEARCH_COLUMNS));
  if (f.platform) q = q.not(`profiles->${f.platform}`, "is", null);
  q = f.order === "a_to_z"
    ? q.order("display_name", { ascending: true }).order("id")
    : q.order("invited_at", { ascending: false }).order("id");
  const { data, error } = await q.range(f.offset, f.offset + f.limit - 1);
  if (error) throw new Error(`creator_invites search failed: ${error.message}`);
  return ((data ?? []) as InviteSearchRow[]).map(projectInvite);
}

async function loadVisibleInvite(inviteId: string): Promise<InviteSearchRow | null> {
  if (!isInviteUuid(inviteId)) return null;
  const { data, error } = await visible(globalClient().from(INVITES).select(SEARCH_COLUMNS))
    .eq("id", inviteId)
    .maybeSingle();
  if (error) throw new Error(`creator_invites read failed: ${error.message}`);
  return (data as InviteSearchRow | null) ?? null;
}

export async function buildInviteCard(inviteId: string) {
  const row = await loadVisibleInvite(inviteId);
  if (!row) return null;
  return {
    human_member_id: `${INVITE_ID_PREFIX}${row.id}`,
    invite_id: row.id,
    invited: true,
    status_label: NOT_ON_ZAVI_LABEL,
    slug: null,
    display_name: row.display_name,
    city: null,
    country_code: null,
    bio: null,
    lanes: [] as string[],
    niches: [] as string[],
    has_intro_video: false,
    photo_url: null,
    illustration_url: null,
    bookable: false,
    socials: inviteSocials(row),
    packages: [] as never[],
    rating: { average: null, count: 0 },
  };
}

export type InviteMessage = { id: string; sender_kind: "tenant"; body: string; created_at: string; emailed: boolean };

type MessageRow = { id: string; body: string; created_at: string; emailed_at: string | null; invite_id?: string };

const toMessage = (r: MessageRow): InviteMessage => ({
  id: r.id,
  sender_kind: "tenant",
  body: r.body,
  created_at: r.created_at,
  emailed: r.emailed_at !== null,
});

export async function listInviteMessages(tenantId: string, inviteId: string): Promise<InviteMessage[]> {
  if (!isInviteUuid(inviteId)) return [];
  const { data, error } = await messagesOf(tenantId)
    .select("id, body, created_at, emailed_at")
    .eq("invite_id", inviteId)
    .is("carried_to_thread_id", null)
    .order("created_at", { ascending: true })
    .limit(MAX_MESSAGES_PER_INVITE + 5);
  if (error) throw new Error(`creator_invite_messages read failed: ${error.message}`);
  return ((data ?? []) as MessageRow[]).map(toMessage);
}

export type InviteConversation = {
  invite_id: string;
  human_member_id: string;
  display_name: string;
  last_message_at: string;
};

export async function listInviteConversations(tenantId: string): Promise<InviteConversation[]> {
  const { data, error } = await messagesOf(tenantId)
    .select("invite_id, created_at")
    .is("carried_to_thread_id", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`creator_invite_messages read failed: ${error.message}`);
  const latest = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ invite_id: string; created_at: string }>) {
    if (!latest.has(r.invite_id)) latest.set(r.invite_id, r.created_at);
  }
  if (latest.size === 0) return [];
  const { data: invites, error: invErr } = await visible(globalClient().from(INVITES).select("id, display_name"))
    .in("id", [...latest.keys()]);
  if (invErr) throw new Error(`creator_invites read failed: ${invErr.message}`);
  return ((invites ?? []) as Array<{ id: string; display_name: string }>)
    .map((i) => ({
      invite_id: i.id,
      human_member_id: `${INVITE_ID_PREFIX}${i.id}`,
      display_name: i.display_name,
      last_message_at: latest.get(i.id) as string,
    }))
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

export class InviteMessageError extends Error {
  constructor(
    readonly code: "invite_not_found" | "too_many_messages",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type PostInviteMessageResult = {
  message: InviteMessage;
  email_note: string;
};

type SendDeps = {
  send: typeof sgSend;
  env: Record<string, string | undefined>;
  inviteCap?: (tenantId: string) => Promise<InviteEmailCap>;
};

type EmailOutcome =
  | { sent: true }
  | { sent: false; reason: "business_daily_cap"; higherPlanAllowsMore: boolean }
  | { sent: false; reason: "other" };

export function isValidInviteEmailCap(cap: unknown): cap is number {
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 0 && cap <= MAX_INVITE_EMAILS_PER_DAY;
}

export function dailyCapNote(first: string, higherPlanAllowsMore: boolean): string {
  const base =
    `Your business has reached today's limit for messaging invited creators on your plan, so ${first} was not emailed about this one. ` +
    "Your message is saved and they see it when they join.";
  return higherPlanAllowsMore ? `${base} A higher plan allows more each day.` : base;
}

export async function postInviteMessage(
  args: { tenant_id: string; user_id: string; invite_id: string; body: string },
  deps: SendDeps = { send: sgSend, env: process.env },
): Promise<PostInviteMessageResult> {
  const invite = await loadVisibleInvite(args.invite_id);
  if (!invite) throw new InviteMessageError("invite_not_found", "Creator not found.", 404);

  const { count, error: countErr } = await messagesOf(args.tenant_id)
    .select("id", { count: "exact", head: true })
    .eq("invite_id", args.invite_id)
    .is("carried_to_thread_id", null);
  if (countErr) throw new Error(`creator_invite_messages count failed: ${countErr.message}`);
  if ((count ?? 0) >= MAX_MESSAGES_PER_INVITE) {
    throw new InviteMessageError(
      "too_many_messages",
      `${invite.display_name} has not joined Zavi yet. You can leave up to ${MAX_MESSAGES_PER_INVITE} messages until they do.`,
      429,
    );
  }

  const scrubbed = scrubContact(args.body);
  const { data, error } = await messagesOf(args.tenant_id)
    .insert({
      invite_id: args.invite_id,
      sender_user_id: args.user_id,
      body: scrubbed.body,
    })
    .select("id, body, created_at, emailed_at")
    .maybeSingle();
  if (error || !data) throw new Error(`creator_invite_messages insert failed: ${error?.message ?? "no row"}`);
  const row = data as MessageRow;

  const outcome = await emailInviteMessage(row, args.tenant_id, invite, deps).catch(
    (): EmailOutcome => ({ sent: false, reason: "other" }),
  );
  const emailed = outcome.sent;
  const first = invite.display_name.split(/\s+/)[0] || invite.display_name;
  return {
    message: { ...toMessage(row), emailed },
    email_note: outcome.sent
      ? `${first} gets an email that you messaged them, with a link to join Zavi and read it.`
      : outcome.reason === "business_daily_cap"
        ? dailyCapNote(first, outcome.higherPlanAllowsMore)
        : `${first} is not on Zavi yet. We could not confirm an email to them this time (they may have been emailed recently). They see this message when they join.`,
  };
}

async function emailInviteMessage(row: MessageRow, tenantId: string, invite: InviteSearchRow, deps: SendDeps): Promise<EmailOutcome> {
  const { cap, higherPlanAllowsMore } = await (deps.inviteCap ?? resolveInviteEmailCap)(tenantId);
  if (!isValidInviteEmailCap(cap)) return { sent: false, reason: "other" };
  const { data: claimed, error: claimErr } = await creatorInviteRpc("creator_invite_message_claim_email", {
    p_message_id: row.id,
    p_daily_cap: cap,
  });
  if (claimErr) throw new Error(`claim email failed: ${claimErr.message}`);
  if (claimed === "business_daily_cap") return { sent: false, reason: "business_daily_cap", higherPlanAllowsMore };
  if (claimed !== "claimed") return { sent: false, reason: "other" };

  const release = async () => {
    await messagesOf(tenantId).update({ emailed_at: null }).eq("id", row.id);
  };

  const { data: secret, error: secretErr } = await globalClient()
    .from(INVITES)
    .select("email, unsub_token, signup_token")
    .eq("id", invite.id)
    .maybeSingle();
  const to = (secret as { email?: string | null } | null)?.email ?? null;
  const token = (secret as { unsub_token?: string } | null)?.unsub_token ?? null;
  const signupToken = (secret as { signup_token?: string | null } | null)?.signup_token ?? null;
  const links = inviteLinkBases(deps.env);
  if (secretErr || !to || !token || !links.web || !links.api) {
    await release();
    return { sent: false, reason: "other" };
  }

  const businessName = (await resolveBusinessName(tenantId).catch(() => "")) || "A business on Zavi";
  const unsubscribeUrl = inviteUnsubscribeUrl(links.api, token);
  const mail = renderInviteMessageEmail({
    name: invite.display_name,
    businessName,
    signupUrl: inviteSignInUrl(links.web, signupToken),
    unsubscribeUrl,
    siteUrl: links.web,
  });
  try {
    await deps.send(to, mail.subject, mail.html, mail.text, systemSender(), {
      customArgs: { creator_invite_id: invite.id },
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    return { sent: true };
  } catch (e) {
    if (classifySendError(e).kind === "rejected") await release().catch(() => undefined);
    void logEvent({
      level: "warn",
      source: "creators/invite-messages",
      code: "creator.invite_message_email_failed",
      message: "an invite message email did not send",
      tenant_id: tenantId,
    }).catch(() => undefined);
    return { sent: false, reason: "other" };
  }
}

export async function prefillInviteAccounts(memberId: string): Promise<number> {
  const db = globalClient();
  const have = await db.from(HANDLES).select("id").eq("human_member_id", memberId).limit(1);
  if (have.error) throw new Error(`human_member_handles read failed: ${have.error.message}`);
  if (((have.data as unknown[] | null) ?? []).length > 0) return 0;
  const { data, error } = await db
    .from(INVITES)
    .select("profiles, followers")
    .eq("human_member_id", memberId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`creator_invites read failed: ${error.message}`);
  const seen = new Set<string>();
  let added = 0;
  for (const invite of (data ?? []) as Array<Pick<InviteSearchRow, "profiles" | "followers">>) {
    for (const s of inviteSocials(invite)) {
      if (seen.has(s.platform)) continue;
      seen.add(s.platform);
      const ins = await db.from(HANDLES).insert({ human_member_id: memberId, platform: s.platform, handle: s.handle, followers: s.followers });
      if (!ins.error) added++;
    }
  }
  return added;
}

export async function carryInviteMessages(memberId: string): Promise<number> {
  const { data: invites, error: invErr } = await globalClient().from(INVITES).select("id").eq("human_member_id", memberId);
  if (invErr) throw new Error(`creator_invites read failed: ${invErr.message}`);
  const inviteIds = ((invites ?? []) as Array<{ id: string }>).map((i) => i.id);
  if (inviteIds.length === 0) return 0;

  const area = creatorAreaClient("carry invite messages into the new creator's threads at signup");
  const { data, error } = await area
    .from(MESSAGES)
    .select("id, tenant_id, sender_user_id, body, created_at")
    .in("invite_id", inviteIds)
    .is("carried_to_thread_id", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`creator_invite_messages read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; tenant_id: string; sender_user_id: string | null; body: string; created_at: string }>;

  const byTenant = new Map<string, typeof rows>();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);

  let carried = 0;
  for (const [tenantId, list] of byTenant) {
    const thread = await ensureCreatorThread({
      tenant_id: tenantId,
      human_member_id: memberId,
      started_by: "tenant",
      started_by_user_id: list[0].sender_user_id,
    });
    const client = tenantClient(asTenantId(tenantId));
    const { data: done, error: doneErr } = await client
      .from("creator_thread_messages")
      .select("id")
      .in("id", list.map((m) => m.id));
    if (doneErr) throw new Error(`creator_thread_messages read failed: ${doneErr.message}`);
    const copied = new Set(((done ?? []) as Array<{ id: string }>).map((d) => d.id));
    const todo = list.filter((m) => !copied.has(m.id));
    const { error: insErr } = todo.length === 0 ? { error: null } : await client.from("creator_thread_messages").insert(
      todo.map((m) => ({
        id: m.id,
        thread_id: thread.id,
        sender_kind: "tenant",
        sender_user_id: m.sender_user_id,
        body: m.body,
        created_at: m.created_at,
      })),
    );
    if (insErr) throw new Error(`creator_thread_messages insert failed: ${insErr.message}`);
    const { error: markErr } = await area
      .from(MESSAGES)
      .update({ carried_to_thread_id: thread.id })
      .eq("tenant_id", tenantId)
      .in("id", list.map((m) => m.id));
    if (markErr) throw new Error(`creator_invite_messages update failed: ${markErr.message}`);
    const lastAt = list[list.length - 1].created_at;
    await client
      .from("creator_threads")
      .update({ last_message_at: lastAt, updated_at: new Date().toISOString() })
      .eq("id", thread.id)
      .or(`last_message_at.is.null,last_message_at.lt.${lastAt}`)
      .then(undefined, () => undefined);
    carried += list.length;
  }
  return carried;
}
