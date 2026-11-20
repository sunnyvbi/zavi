
import { parseSocial } from "@zavi/shared";
import { parseCsv } from "@/services/knowledge-import/scrub";
import { creatorInviteRpc, globalClient } from "@/services/tenant-client";

const INVITES = "creator_invites";

export const HOLD_REASONS = [
  "test_address",
  "prior_bounce",
  "prior_declined",
  "agency",
  "eu_domain",
  "duplicate_review",
  "email_conflict",
  "no_email",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const REQUIRED_HEADERS = [
  "Creator",
  "Email",
  "Outreach status",
  "Reply status",
  "Source URL",
  "IG profile",
  "X profile",
  "YouTube channel",
  "IG",
  "X",
  "YT subscribers",
  "Identity / data check",
  "Next action (not sent)",
] as const;

type ProfilePlatform = "instagram" | "x" | "youtube";
export type ProfileLink = { url: string; handle: string | null };
export type FollowerCount = { raw: string; n: number | null };

export type SheetRow = {
  sheetRow: number;
  sourceKey: string;
  displayName: string;
  email: string | null;
  profiles: Partial<Record<ProfilePlatform, ProfileLink>>;
  followers: Partial<Record<ProfilePlatform, FollowerCount>>;
  sourceMeta: { sheet_row: number; outreach_status: string; reply_status: string; source_host: string | null };
  inConversation: boolean;
  holdReason: HoldReason | null;
};

export type SheetReport = {
  rowsRead: number;
  blankRows: number;
  errors: { sheetRow: number; reason: string }[];
  sheetDuplicates: number[];
  sameEmailDuplicates: number[];
  duplicateReview: number[];
  sourceKeyDuplicates: number[];
  sharedDomains: string[];
};

export const BUILT_IN_AGENCY_DOMAINS: readonly string[] = [
  "caa.com",
  "wmeagency.com",
  "unitedtalent.com",
  "gersh.com",
  "icmpartners.com",
  "speakersassociates.com",
  "arab-influencer-agency.com",
];

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "yahoo.co.uk", "yahoo.fr",
  "ymail.com", "rocketmail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.it",
  "outlook.com", "outlook.in", "live.com", "live.in", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de",
  "yandex.com", "yandex.ru", "mail.ru", "zoho.com", "hey.com", "qq.com", "163.com", "126.com",
  "rediffmail.com", "naver.com", "fastmail.com", "tutanota.com", "libero.it", "orange.fr", "free.fr",
  "yopmail.com", "mailinator.com",
]);

const EU_UK_TLDS = new Set([
  "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie", "it",
  "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se",
  "is", "li", "no", "uk", "gb", "ch", "eu",
]);

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 320 ? v : null;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

export function isEuUkDomain(domain: string): boolean {
  return EU_UK_TLDS.has(domain.slice(domain.lastIndexOf(".") + 1));
}

export function parseFollowers(raw: string): number | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\+$/, "");
  if (!v) return null;
  const m = v.match(/^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)([km])?$/);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  const mult = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  const n = Math.round(base * mult);
  return Number.isFinite(n) && n >= 0 && n <= 5_000_000_000 ? n : null;
}

export function normalizeUrl(raw: string): string {
  let v = raw.trim().replace(/^\\+/, "").toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/#.*$/, "").replace(/\/+$/, "");
  return v;
}

function hostOf(raw: string): string | null {
  const v = raw.trim().replace(/^\\+/, "");
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function platformForHost(host: string | null): ProfilePlatform | null {
  if (!host) return null;
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  return null;
}

function profileLink(platform: ProfilePlatform, raw: string): ProfileLink | null {
  const url = raw.trim().replace(/^\\+/, "");
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const parsed = parseSocial(platform, url);
  return { url: url.slice(0, 500), handle: parsed.ok ? parsed.value.handle : null };
}

export function isInConversation(outreach: string, reply: string): boolean {
  if (/^(sent|inbound only)$/i.test(outreach.trim())) return true;
  return /replied|awaiting reply|auto reply/i.test(reply);
}

export function isPriorBounce(outreach: string, reply: string): boolean {
  return /bounced/i.test(outreach) || /delivery failed/i.test(reply);
}

export function isPriorDeclined(reply: string): boolean {
  return /declined/i.test(reply);
}

export function sheetDuplicateOf(note: string): number | null {
  const m = note.match(/duplicate of row (\d+)/i);
  return m ? Number(m[1]) : null;
}

const HOLD_PRECEDENCE: HoldReason[] = [
  "test_address",
  "prior_bounce",
  "prior_declined",
  "agency",
  "eu_domain",
  "duplicate_review",
  "email_conflict",
  "no_email",
];

function strongestHold(reasons: (HoldReason | null)[]): HoldReason | null {
  for (const h of HOLD_PRECEDENCE) if (reasons.includes(h)) return h;
  return null;
}

type Draft = SheetRow & {
  nameKey: string;
  flags: { bounce: boolean; declined: boolean; conversation: boolean };
  duplicateOf: number | null;
};

export function parseCreatorSheet(
  text: string,
  opts: { excludeDomains?: readonly string[] } = {},
): { rows: SheetRow[]; report: SheetReport } {
  const report: SheetReport = {
    rowsRead: 0,
    blankRows: 0,
    errors: [],
    sheetDuplicates: [],
    sameEmailDuplicates: [],
    duplicateReview: [],
    sourceKeyDuplicates: [],
    sharedDomains: [],
  };
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (!table || table.length === 0) throw new Error("The file is not a readable CSV (unbalanced quotes?).");

  const header = table[0].map((h) => h.trim());
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`The CSV is missing columns: ${missing.join(", ")}`);
  const col = (name: (typeof REQUIRED_HEADERS)[number]) => header.indexOf(name);

  const drafts: Draft[] = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const sheetRow = i + 1;
    if (cells.every((c) => !c.trim())) {
      report.blankRows += 1;
      continue;
    }
    report.rowsRead += 1;
    if (cells.length !== header.length) {
      report.errors.push({ sheetRow, reason: `has ${cells.length} cells, the header has ${header.length}` });
      continue;
    }
    const get = (name: (typeof REQUIRED_HEADERS)[number]) => (cells[col(name)] ?? "").trim();
    const displayName = get("Creator").replace(/\s+/g, " ");
    if (!displayName) {
      report.errors.push({ sheetRow, reason: "empty Creator name" });
      continue;
    }
    if (displayName.length > 120) {
      report.errors.push({ sheetRow, reason: "Creator name longer than 120 characters" });
      continue;
    }

    const outreach = get("Outreach status");
    const reply = get("Reply status");
    const sourceUrl = get("Source URL");
    const sourceHost = hostOf(sourceUrl);

    const profiles: SheetRow["profiles"] = {};
    const ig = profileLink("instagram", get("IG profile"));
    const xp = profileLink("x", get("X profile"));
    const yt = profileLink("youtube", get("YouTube channel"));
    if (ig) profiles.instagram = ig;
    if (xp) profiles.x = xp;
    if (yt) profiles.youtube = yt;
    const sourcePlatform = platformForHost(sourceHost);
    if (sourcePlatform && !profiles[sourcePlatform]) {
      const link = profileLink(sourcePlatform, sourceUrl);
      if (link) profiles[sourcePlatform] = link;
    }

    const followers: SheetRow["followers"] = {};
    for (const [platform, name] of [["instagram", "IG"], ["x", "X"], ["youtube", "YT subscribers"]] as const) {
      const raw = get(name);
      if (raw) followers[platform] = { raw: raw.slice(0, 40), n: parseFollowers(raw) };
    }

    const email = normalizeEmail(get("Email"));
    const note = `${get("Identity / data check")} ${get("Next action (not sent)")}`;
    const nameKey = displayName.toLowerCase();
    drafts.push({
      sheetRow,
      nameKey,
      sourceKey: `${nameKey}|${normalizeUrl(sourceUrl)}`.slice(0, 600),
      displayName,
      email,
      profiles,
      followers,
      sourceMeta: { sheet_row: sheetRow, outreach_status: outreach.slice(0, 80), reply_status: reply.slice(0, 80), source_host: sourceHost },
      inConversation: false,
      holdReason: null,
      flags: {
        bounce: isPriorBounce(outreach, reply),
        declined: isPriorDeclined(reply),
        conversation: isInConversation(outreach, reply),
      },
      duplicateOf: sheetDuplicateOf(note),
    });
  }

  const byRow = new Map(drafts.map((d) => [d.sheetRow, d]));
  const parent = new Map<number, number>(drafts.map((d) => [d.sheetRow, d.sheetRow]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  const firstBy = new Map<string, number>();
  for (const d of drafts) {
    for (const key of [d.email ? `e:${d.email}` : null, `k:${d.sourceKey}`]) {
      if (!key) continue;
      const seen = firstBy.get(key);
      if (seen === undefined) firstBy.set(key, d.sheetRow);
      else union(d.sheetRow, seen);
    }
    if (d.duplicateOf !== null && byRow.has(d.duplicateOf)) union(d.sheetRow, d.duplicateOf);
  }
  const merged = new Map<number, Draft["flags"]>();
  for (const d of drafts) {
    const root = find(d.sheetRow);
    const f = merged.get(root) ?? { bounce: false, declined: false, conversation: false };
    merged.set(root, { bounce: f.bounce || d.flags.bounce, declined: f.declined || d.flags.declined, conversation: f.conversation || d.flags.conversation });
  }
  for (const d of drafts) d.flags = { ...(merged.get(find(d.sheetRow)) as Draft["flags"]) };

  const byEmail = new Map<string, Draft[]>();
  for (const d of drafts) if (d.email) byEmail.set(d.email, [...(byEmail.get(d.email) ?? []), d]);

  const dropped = new Set<number>();
  for (const d of drafts) {
    if (d.duplicateOf !== null) {
      dropped.add(d.sheetRow);
      report.sheetDuplicates.push(d.sheetRow);
    }
  }
  for (const group of byEmail.values()) {
    const live = group.filter((d) => !dropped.has(d.sheetRow));
    for (const d of live.slice(1)) {
      if (d.nameKey === live[0].nameKey) {
        dropped.add(d.sheetRow);
        report.sameEmailDuplicates.push(d.sheetRow);
      } else {
        d.email = null;
        d.holdReason = "duplicate_review";
        report.duplicateReview.push(d.sheetRow);
      }
    }
  }
  const seenKeys = new Set<string>();
  for (const d of drafts) {
    if (dropped.has(d.sheetRow)) continue;
    if (seenKeys.has(d.sourceKey)) {
      dropped.add(d.sheetRow);
      report.sourceKeyDuplicates.push(d.sheetRow);
    } else seenKeys.add(d.sourceKey);
  }

  const agency = new Set([...BUILT_IN_AGENCY_DOMAINS, ...(opts.excludeDomains ?? [])].map((d) => d.toLowerCase()));
  const namesByDomain = new Map<string, Set<string>>();
  for (const d of drafts) {
    if (!d.email || dropped.has(d.sheetRow)) continue;
    const dom = emailDomain(d.email);
    if (FREE_MAIL_DOMAINS.has(dom)) continue;
    namesByDomain.set(dom, (namesByDomain.get(dom) ?? new Set()).add(d.nameKey));
  }
  for (const [dom, names] of namesByDomain) {
    if (names.size >= 2 && !agency.has(dom)) {
      agency.add(dom);
      report.sharedDomains.push(dom);
    }
  }

  const rows: SheetRow[] = [];
  for (const d of drafts) {
    if (dropped.has(d.sheetRow)) continue;
    const dom = d.email ? emailDomain(d.email) : null;
    const holdReason = strongestHold([
      d.flags.bounce ? "prior_bounce" : null,
      d.flags.declined ? "prior_declined" : null,
      dom && agency.has(dom) ? "agency" : null,
      dom && isEuUkDomain(dom) ? "eu_domain" : null,
      d.holdReason,
      d.email ? null : "no_email",
    ]);
    rows.push({
      sheetRow: d.sheetRow,
      sourceKey: d.sourceKey,
      displayName: d.displayName,
      email: d.email,
      profiles: d.profiles,
      followers: d.followers,
      sourceMeta: d.sourceMeta,
      inConversation: d.flags.conversation,
      holdReason,
    });
  }
  return { rows, report };
}

export type InviteRow = {
  id: string;
  source_key: string;
  email: string | null;
  display_name: string;
  hold_reason: HoldReason | null;
  in_conversation: boolean;
  batch: string;
  unsub_token: string;
  signup_token?: string | null;
  invited_at: string | null;
  send_failed_at: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  human_member_id: string | null;
  claimed_at: string | null;
  member_deleted_at: string | null;
  source_meta: { sheet_row?: number } | null;
};

const INVITE_COLUMNS =
  "id, source_key, email, display_name, hold_reason, in_conversation, batch, unsub_token, signup_token, invited_at, send_failed_at, unsubscribed_at, bounced_at, human_member_id, claimed_at, member_deleted_at, source_meta";

function fail(error: { message: string } | null | undefined, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Filter = {
  eq(column: string, value: unknown): Filter;
  in(column: string, values: readonly unknown[]): Filter;
  not(column: string, op: string, value: unknown): Filter;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

async function selectAll(filter: (q: Filter) => Filter): Promise<InviteRow[]> {
  const out: InviteRow[] = [];
  for (let from = 0; ; from += 1000) {
    const base = globalClient().from(INVITES).select(INVITE_COLUMNS).order("created_at", { ascending: true }).order("id");
    const { data, error } = await filter(base as unknown as Filter).range(from, from + 999);
    fail(error, "read creator_invites");
    const page = (data ?? []) as InviteRow[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function existingAccounts(emails: readonly string[]): Promise<Map<string, "creator" | "account">> {
  const out = new Map<string, "creator" | "account">();
  const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
  for (const part of chunks(unique, 200)) {
    const { data, error } = await creatorInviteRpc("creator_invite_existing_accounts", { p_emails: part });
    fail(error, "check existing accounts");
    for (const r of (data ?? []) as { email: string; kind: "creator" | "account" }[]) out.set(r.email, r.kind);
  }
  return out;
}

export type UpsertResult = {
  inserted: number;
  updated: number;
  skippedDeleted: number[];
  emailConflicts: number[];
};

export async function upsertFromSheet(rows: readonly SheetRow[], batch: string, apply: boolean): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: 0, updated: 0, skippedDeleted: [], emailConflicts: [] };
  const existing = new Map<string, InviteRow>();
  for (const part of chunks(rows.map((r) => r.sourceKey), 200)) {
    const found = await selectAll((q) => q.in("source_key", part));
    for (const r of found) existing.set(r.source_key, r);
  }
  type Holder = { sourceKey: string; dbId?: string; insert?: Record<string, unknown> };
  const holders = new Map<string, Holder>();
  const priorById = new Map([...existing.values()].map((r) => [r.id, r]));
  for (const r of await selectAll((q) => q.not("email", "is", null))) {
    if (r.email) holders.set(r.email.toLowerCase(), { sourceKey: r.source_key, dbId: r.id });
    priorById.set(r.id, r);
  }
  const patches = new Map<string, Record<string, unknown>>();
  const patchFor = (id: string) => patches.get(id) ?? (patches.set(id, {}), patches.get(id) as Record<string, unknown>);
  const sticky = (h: HoldReason | null) =>
    h === "test_address" || h === "prior_bounce" || h === "prior_declined" ? h : null;

  const propagate = (email: string, row: SheetRow) => {
    const holder = holders.get(email);
    if (!holder || holder.sourceKey === row.sourceKey) return;
    const s = sticky(row.holdReason);
    if (!s && !row.inConversation) return;
    if (holder.insert) {
      if (s) holder.insert.hold_reason = strongestHold([holder.insert.hold_reason as HoldReason | null, s]);
      holder.insert.in_conversation = (holder.insert.in_conversation as boolean) || row.inConversation;
      return;
    }
    if (!holder.dbId) return;
    const p = patchFor(holder.dbId);
    const base = (p.hold_reason as HoldReason | null | undefined) ?? priorById.get(holder.dbId)?.hold_reason ?? null;
    if (s) p.hold_reason = strongestHold([base, s]);
    if (row.inConversation) p.in_conversation = true;
  };

  const inserts: Record<string, unknown>[] = [];
  for (const row of rows) {
    const prior = existing.get(row.sourceKey);
    const holder = row.email ? holders.get(row.email) : undefined;
    const emailTaken = !!holder && holder.sourceKey !== row.sourceKey;
    const rowHold = row.holdReason === "no_email" ? null : row.holdReason;

    if (!prior) {
      if (emailTaken && holder?.dbId && priorById.get(holder.dbId)?.member_deleted_at) {
        result.skippedDeleted.push(row.sheetRow);
        continue;
      }
      if (emailTaken) {
        result.emailConflicts.push(row.sheetRow);
        propagate(row.email as string, row);
      }
      const obj: Record<string, unknown> = {
        source_key: row.sourceKey,
        email: emailTaken ? null : row.email,
        display_name: row.displayName,
        profiles: row.profiles,
        followers: row.followers,
        source_meta: row.sourceMeta,
        hold_reason: emailTaken ? strongestHold([rowHold, "email_conflict"]) : row.holdReason,
        in_conversation: row.inConversation,
        batch,
      };
      inserts.push(obj);
      if (row.email && !emailTaken) holders.set(row.email, { sourceKey: row.sourceKey, insert: obj });
      continue;
    }
    if (prior.member_deleted_at) {
      result.skippedDeleted.push(row.sheetRow);
      continue;
    }

    const p = patchFor(prior.id);
    Object.assign(p, {
      display_name: row.displayName,
      profiles: row.profiles,
      followers: row.followers,
      source_meta: row.sourceMeta,
      in_conversation: prior.in_conversation || row.inConversation || p.in_conversation === true,
    });
    const priorHold = (p.hold_reason as HoldReason | null | undefined) ?? prior.hold_reason;
    const storedEmail = prior.email?.toLowerCase() ?? null;
    if (storedEmail && row.email === storedEmail) {
      p.hold_reason = strongestHold([sticky(priorHold), rowHold]);
    } else if (storedEmail && !row.email) {
      p.hold_reason = strongestHold([priorHold, sticky(row.holdReason)]);
    } else if (storedEmail && row.email) {
      result.emailConflicts.push(row.sheetRow);
      p.hold_reason = strongestHold([priorHold, sticky(row.holdReason), "email_conflict"]);
      propagate(row.email, row);
    } else if (row.email && !emailTaken) {
      p.email = row.email;
      p.hold_reason = strongestHold([sticky(priorHold), rowHold]);
      holders.set(row.email, { sourceKey: row.sourceKey, dbId: prior.id });
    } else if (row.email) {
      result.emailConflicts.push(row.sheetRow);
      p.hold_reason = strongestHold([sticky(priorHold), rowHold, "email_conflict"]);
      propagate(row.email, row);
    } else {
      p.hold_reason = strongestHold([sticky(priorHold), row.holdReason]);
    }
  }
  const updates = [...patches.entries()].map(([id, patch]) => ({ id, patch: { ...patch, updated_at: new Date().toISOString() } }));

  if (!apply) {
    result.inserted = inserts.length;
    result.updated = updates.length;
    return result;
  }
  for (const part of chunks(inserts, 200)) {
    const { error } = await globalClient().from(INVITES).insert(part);
    fail(error, "insert creator_invites");
    result.inserted += part.length;
  }
  for (const u of updates) {
    const { error } = await globalClient().from(INVITES).update(u.patch).eq("id", u.id).is("member_deleted_at", null);
    fail(error, "update creator_invites");
    result.updated += 1;
  }
  return result;
}

export async function cleanupUntouched(batch: string, apply: boolean): Promise<number> {
  const rows = await selectAll((q) => q.eq("batch", batch));
  const untouched = rows.filter(
    (r) => !r.invited_at && !r.send_failed_at && !r.unsubscribed_at && !r.bounced_at && !r.human_member_id && !r.claimed_at,
  );
  if (!apply) return untouched.length;
  let deleted = 0;
  for (const part of chunks(untouched.map((r) => r.id), 200)) {
    const { data, error } = await globalClient()
      .from(INVITES)
      .delete()
      .in("id", part)
      .is("invited_at", null)
      .is("send_failed_at", null)
      .is("unsubscribed_at", null)
      .is("bounced_at", null)
      .is("human_member_id", null)
      .is("claimed_at", null)
      .select("id");
    fail(error, "delete creator_invites");
    deleted += (data ?? []).length;
  }
  return deleted;
}

export async function countBatch(batch: string): Promise<number> {
  const { count, error } = await globalClient().from(INVITES).select("id", { count: "exact", head: true }).eq("batch", batch);
  fail(error, "count batch");
  return count ?? 0;
}

export async function reconcileLinks(): Promise<number> {
  const { data, error } = await creatorInviteRpc("creator_invite_reconcile_links");
  fail(error, "reconcile invite links");
  return Number(data ?? 0);
}

export type InviteMode = "invite" | "retry";

export type EligibilityOptions = {
  batch: string;
  mode: InviteMode;
  rows?: readonly number[];
  skipRows?: readonly number[];
  includeInConversation?: boolean;
};

export type Eligibility = {
  candidates: InviteRow[];
  skipped: { sheetRow: number | null; name: string; reason: string }[];
};

const sheetRowOf = (r: InviteRow): number | null => (typeof r.source_meta?.sheet_row === "number" ? r.source_meta.sheet_row : null);

export async function eligibleRows(opts: EligibilityOptions): Promise<Eligibility> {
  const all = await selectAll((q) => q.eq("batch", opts.batch));
  const skipped: Eligibility["skipped"] = [];
  const wanted = opts.rows?.length ? new Set(opts.rows) : null;
  const skip = new Set(opts.skipRows ?? []);

  const pool = all
    .filter((r) => {
      const row = sheetRowOf(r);
      if (wanted && (row === null || !wanted.has(row))) return false;
      if (row !== null && skip.has(row)) {
        skipped.push({ sheetRow: row, name: r.display_name, reason: "skipped by --skip-rows" });
        return false;
      }
      return true;
    })
    .sort((a, b) => (sheetRowOf(a) ?? 1e9) - (sheetRowOf(b) ?? 1e9));

  const candidates: InviteRow[] = [];
  for (const r of pool) {
    const reason = ineligibleReason(r, opts.mode, !!opts.includeInConversation);
    if (reason) {
      if (wanted) skipped.push({ sheetRow: sheetRowOf(r), name: r.display_name, reason });
      continue;
    }
    candidates.push(r);
  }
  if (wanted) {
    const found = new Set(pool.map(sheetRowOf));
    for (const row of wanted) if (!found.has(row)) skipped.push({ sheetRow: row, name: "", reason: "no such row in this batch" });
  }

  if (candidates.length) {
    const accounts = await existingAccounts(candidates.map((r) => r.email as string));
    const kept: InviteRow[] = [];
    for (const r of candidates) {
      const kind = accounts.get((r.email as string).toLowerCase());
      if (kind) skipped.push({ sheetRow: sheetRowOf(r), name: r.display_name, reason: `already has a Zavi ${kind === "creator" ? "creator " : ""}account` });
      else kept.push(r);
    }
    return { candidates: kept, skipped };
  }
  return { candidates, skipped };
}

export function ineligibleReason(r: InviteRow, mode: InviteMode, includeInConversation: boolean): string | null {
  if (!r.email) return "no email";
  if (r.member_deleted_at) return "creator account was deleted";
  if (r.unsubscribed_at) return "unsubscribed";
  if (r.bounced_at) return "bounced";
  if (r.hold_reason) return `held: ${r.hold_reason}`;
  if (r.human_member_id || r.claimed_at) return "already signed up";
  if (r.in_conversation && !includeInConversation) return "already in an email conversation";
  if (mode === "retry") return r.send_failed_at ? null : "no failed invite to retry";
  return r.invited_at ? "already invited" : null;
}

export async function stampInvite(id: string, opts: { includeInConversation: boolean; retry: boolean }): Promise<boolean> {
  const { data, error } = await creatorInviteRpc("creator_invite_stamp", {
    p_id: id,
    p_include_in_conversation: opts.includeInConversation,
    p_retry: opts.retry,
  });
  fail(error, "stamp invite");
  return data === true;
}

export async function markSendFailed(id: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await globalClient()
    .from(INVITES)
    .update({ send_failed_at: now, last_error: message.slice(0, 500), updated_at: now })
    .eq("id", id);
  fail(error, "record send failure");
}

export async function linkInviteOnSignup(email: string, memberId: string): Promise<number> {
  const { data, error } = await creatorInviteRpc("creator_invite_link_signup", { p_email: email, p_member_id: memberId });
  fail(error, "link invite on signup");
  return Number(data ?? 0);
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function invitePrefill(token: string): Promise<{ name: string; email: string } | null> {
  if (!isUuid(token)) return null;
  const { data, error } = await globalClient()
    .from(INVITES)
    .select("display_name, email, member_deleted_at")
    .eq("signup_token", token)
    .maybeSingle();
  fail(error, "read invite prefill");
  const r = data as { display_name?: string; email?: string | null; member_deleted_at?: string | null } | null;
  if (!r?.email || r.member_deleted_at) return null;
  return { name: r.display_name ?? "", email: r.email };
}

export async function unsubscribeInvite(token: string, source: "link" | "one_click"): Promise<void> {
  if (!isUuid(token)) return;
  const now = new Date().toISOString();
  const { error } = await globalClient()
    .from(INVITES)
    .update({ unsubscribed_at: now, unsubscribe_source: source, updated_at: now })
    .eq("unsub_token", token)
    .is("unsubscribed_at", null);
  fail(error, "unsubscribe invite");
}

export async function markInviteBounced(id: string, reason: string): Promise<void> {
  if (!isUuid(id)) return;
  const now = new Date().toISOString();
  const { error } = await globalClient()
    .from(INVITES)
    .update({ bounced_at: now, bounce_reason: reason.slice(0, 200), updated_at: now })
    .eq("id", id)
    .is("bounced_at", null);
  fail(error, "mark invite bounced");
}

export async function recordSendAmbiguous(id: string, message: string): Promise<void> {
  const { error } = await globalClient()
    .from(INVITES)
    .update({ last_error: `ambiguous: ${message}`.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", id);
  fail(error, "record ambiguous send");
}

export function parseRowList(raw: string | undefined, flag: string): number[] {
  if (raw === undefined) return [];
  const bad = () => new Error(`${flag} must be sheet row numbers (2 or more) or ranges, e.g. 12,40 or 12-50, got "${raw}".`);
  if (!raw.trim()) throw bad();
  const rows: number[] = [];
  for (const part of raw.split(",").map((s) => s.trim())) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw bad();
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 2 || to < from || to - from > 5000) throw bad();
    for (let n = from; n <= to; n++) rows.push(n);
  }
  return [...new Set(rows)];
}

export function sendPreflight(opts: {
  apply: boolean;
  acknowledgedNoGeo: boolean;
  sendgridKey: string | undefined;
  renderSample: (() => void) | null;
  linkBases?: { web: string | null; api: string | null };
}): string[] {
  const problems: string[] = [];
  if (opts.linkBases) {
    for (const [name, base] of Object.entries(opts.linkBases)) {
      const envName = name === "web" ? "PRAXIS_PUBLIC_BASE" : "BACKEND_PUBLIC_URL";
      if (!base) problems.push(`${envName} is not set (copy it from the backend secret into apps/backend/.env)`);
      else if (!isPublicHttpsBase(base)) problems.push(`${envName} "${base}" is not a public https URL`);
    }
  }
  if (!opts.sendgridKey?.trim()) problems.push("SYSTEM_SENDGRID_API_KEY is not set");
  if (opts.apply && !opts.acknowledgedNoGeo) {
    problems.push("--acknowledge-no-geo is required: the sheet has no country column, only EU/UK email domains are filtered");
  }
  if (opts.renderSample) {
    try {
      opts.renderSample();
    } catch (e) {
      problems.push(`the email does not render: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

export function classifySendError(e: unknown): { kind: "rejected" | "ambiguous"; stop: boolean } {
  const code = Number((e as { code?: unknown })?.code);
  const hasResponse = !!(e as { response?: unknown })?.response;
  const msg = e instanceof Error ? e.message : String(e);
  const localConfig = /SYSTEM_SENDGRID_API_KEY|api key/i.test(msg) && !hasResponse;
  if (localConfig) return { kind: "rejected", stop: true };
  if (hasResponse && code >= 400 && code < 500) return { kind: "rejected", stop: [401, 403, 429].includes(code) };
  return { kind: "ambiguous", stop: true };
}

export function inviteLinkBases(env: Record<string, string | undefined>): { web: string | null; api: string | null } {
  const clean = (v: string | undefined) => (v?.trim() ? v.trim().replace(/\/+$/, "") : null);
  return { web: clean(env.PRAXIS_PUBLIC_BASE), api: clean(env.BACKEND_PUBLIC_URL) };
}

export function isPublicHttpsBase(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/i.test(u.hostname) && !u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function pickFirstInvitable(rows: readonly SheetRow[], accounts: ReadonlyMap<string, unknown>, n: number): SheetRow[] {
  return rows
    .filter((r) => r.email && !r.holdReason && !r.inConversation && !accounts.has(r.email))
    .sort((a, b) => a.sheetRow - b.sheetRow)
    .slice(0, n);
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function missingEmailCsv(rows: readonly SheetRow[]): string {
  const lines = rows
    .filter((r) => !r.email)
    .sort((a, b) => a.sheetRow - b.sheetRow)
    .map((r) => [String(r.sheetRow), csvCell(r.displayName), r.holdReason ?? ""].join(","));
  return ["sheet_row,creator,hold_reason", ...lines].join("\n") + "\n";
}

export type ListedInvite = {
  display_name: string;
  email: string | null;
  label: string;
  hold_reason: string | null;
  in_conversation: boolean;
  profiles: Record<string, { url?: string; handle?: string | null }> | null;
  followers: Record<string, { raw?: string; n?: number | null }> | null;
  source_meta: { sheet_row?: number } | null;
};

export async function listBatch(batch: string): Promise<ListedInvite[]> {
  const out: ListedInvite[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await globalClient()
      .from("creator_invite_status")
      .select("display_name, email, label, hold_reason, in_conversation, profiles, followers, source_meta")
      .eq("batch", batch)
      .order("created_at", { ascending: true })
      .order("id")
      .range(from, from + 999);
    fail(error, "read creator_invite_status");
    const page = (data ?? []) as ListedInvite[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out.sort((a, b) => (a.source_meta?.sheet_row ?? 1e9) - (b.source_meta?.sheet_row ?? 1e9));
}

export function formatListedInvite(r: ListedInvite, showEmail: boolean): string {
  const profiles = Object.entries(r.profiles ?? {})
    .map(([p, v]) => `${p}:${v?.handle ?? v?.url ?? "?"}`)
    .join(" ");
  const followers = Object.entries(r.followers ?? {})
    .map(([p, v]) => `${p}=${v?.n ?? v?.raw ?? "?"}`)
    .join(" ");
  const email = showEmail ? (r.email ?? "(no email)") : r.email ? "email ✓" : "no email";
  return [
    `row ${r.source_meta?.sheet_row ?? "?"}`,
    r.display_name,
    email,
    r.label + (r.hold_reason ? ` (${r.hold_reason})` : "") + (r.in_conversation ? " [in conversation]" : ""),
    profiles || "no profiles",
    followers || "no follower counts",
  ].join(" · ");
}
