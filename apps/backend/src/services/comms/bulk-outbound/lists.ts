
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { cleanAddresses } from "./contacts-csv";
import { CONSENT_SENTENCE, LIST_VERSION_MAX_CONTACTS } from "./config";
import { BulkEmailError } from "./errors";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

async function rpc(tenantId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = (await tenantRpc(asTenantId(tenantId), name, args)) as RpcResult;
  if (error?.code === "23505" && String(error.message ?? "").includes("email_lists_tenant_name_uq")) {
    return { ok: false, reason: "name_taken" };
  }
  if (error) throw new BulkEmailError("bulk_store_error", "Something went wrong saving that. Try again.", 500);
  return data;
}

const STORE_ERROR: [number, string] = [500, "Something went wrong saving that. Try again."];

const IMPORT_REFUSALS: Record<string, [number, string]> = {
  no_addresses: [400, "We did not find any email addresses to import."],
  too_many: [400, "A list can hold up to 10,000 contacts. Split it into smaller lists."],
  not_a_member: [403, "You are not a member of this workspace."],
  list_not_found: [404, "That contact list was not found."],
  invalid_name: [400, "Give the list a name of 1 to 120 characters."],
  name_taken: [409, "You already have a list with that name. Pick another name."],
  invalid_address: [400, "One of those values is not a plain email address, so nothing was imported."],
  list_changed: [409, "Someone else added to this list at the same moment. Try again."],
};

const IMPORT_ATTEMPTS = 2;

export function cleanListName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  return name || null;
}

export type ImportResult = {
  list_id: string | null;
  version_id: string | null;
  added: number;
  invalid: number;
  duplicates: number;
  over_limit: number;
  already_unsubscribed: number;
  skipped_erased: number;
};

export type ImportReceived = { list_id: string; version_id: string; received: true; membership_hidden: true };

async function assertOpenList(tenantId: string, listId: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("email_lists")
    .select("id")
    .eq("id", listId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new BulkEmailError("bulk_store_error", STORE_ERROR[1], 500);
  if (!data) throw new BulkEmailError("list_not_found", IMPORT_REFUSALS.list_not_found[1], 404);
}

const MIXED_SOURCES = "database_and_csv";

function isMixedRef(ref: unknown): boolean {
  return !!ref && typeof ref === "object" && (ref as { mixed?: unknown }).mixed === MIXED_SOURCES;
}

const ERASED_PAGE = 1000;

async function erasedAddresses(tenantId: string): Promise<Set<string>> {
  const db = tenantClient(asTenantId(tenantId));
  const erased = new Set<string>();
  for (let from = 0; ; ) {
    const { data, error } = await db
      .from("email_suppression")
      .select("email")
      .eq("reason", "erased")
      .order("email", { ascending: true })
      .range(from, from + ERASED_PAGE - 1);
    if (error) throw new BulkEmailError("bulk_store_error", STORE_ERROR[1], 500);
    const rows = (data ?? []) as Array<{ email: string }>;
    if (rows.length === 0) return erased;
    for (const row of rows) erased.add(row.email.toLowerCase());
    from += rows.length;
  }
}

async function currentListEmails(
  tenantId: string,
  listId: string,
): Promise<{ versionId: string | null; fromDatabase: boolean; mixed: boolean; emails: string[] }> {
  const { data: latest, error } = await tenantClient(asTenantId(tenantId))
    .from("email_list_versions")
    .select("id, source_kind, source_ref")
    .eq("list_id", listId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new BulkEmailError("bulk_store_error", STORE_ERROR[1], 500);
  const versionId = (latest as { id?: unknown } | null)?.id;
  if (typeof versionId !== "string") return { versionId: null, fromDatabase: false, mixed: false, emails: [] };
  const fromDatabase = (latest as { source_kind?: unknown }).source_kind === "database";
  const mixed = isMixedRef((latest as { source_ref?: unknown }).source_ref);
  const emails = await rpc(tenantId, "email_list_version_emails", {
    p_list_id: listId,
    p_version_id: versionId,
    p_limit: LIST_VERSION_MAX_CONTACTS + 1,
  });
  return { versionId, fromDatabase, mixed, emails: Array.isArray(emails) ? emails.filter((e): e is string => typeof e === "string") : [] };
}

export async function importListVersion(args: {
  tenantId: string;
  userId: string;
  listId?: string | null;
  name?: string | null;
  sourceKind: "csv" | "database";
  sourceRef?: Record<string, string>;
  values: readonly unknown[];
  names?: readonly unknown[] | null;
  cap: number;
  canSeeDatabaseAddresses?: boolean;
}): Promise<ImportResult | ImportReceived> {
  const cleanedValues = cleanAddresses(args.values, args.cap, args.names ?? undefined);
  const blank = args.sourceKind === "database" ? args.values.filter((v) => typeof v !== "string" || v.trim() === "").length : 0;
  const cleaned = { ...cleanedValues, invalid: cleanedValues.invalid + blank };
  if (cleaned.emails.length === 0) {
    throw new BulkEmailError(
      "no_addresses",
      args.sourceKind === "database"
        ? "That column has no valid email addresses. Choose the column that holds them."
        : IMPORT_REFUSALS.no_addresses[1],
    );
  }
  const inFile = new Set(cleaned.emails);
  for (let attempt = 1; ; attempt++) {
    const current = args.listId
      ? await currentListEmails(args.tenantId, args.listId)
      : { versionId: null, fromDatabase: false, mixed: false, emails: [] };
    const hidden = current.fromDatabase && args.canSeeDatabaseAddresses !== true;
    const erased = await erasedAddresses(args.tenantId);
    const liveFile = cleaned.emails.flatMap((email, i) => (erased.has(email) ? [] : [{ email, name: cleaned.names?.[i] ?? null }]));
    const skippedErased = cleaned.emails.length - liveFile.length;
    if (liveFile.length === 0) {
      if (args.listId) await assertOpenList(args.tenantId, args.listId);
      if (hidden) return { list_id: args.listId as string, version_id: current.versionId as string, received: true, membership_hidden: true };
      return {
        list_id: args.listId ?? null,
        version_id: null,
        added: 0,
        invalid: cleaned.invalid,
        duplicates: cleaned.duplicates,
        over_limit: cleaned.over_limit,
        already_unsubscribed: 0,
        skipped_erased: skippedErased,
      };
    }
    const fileEmails = liveFile.map((p) => p.email);
    const fileNames = liveFile.map((p) => p.name);
    const withNames = fileNames.some((n) => n !== null);
    const onList = new Set(current.emails);
    const kept = current.emails.filter((e) => !inFile.has(e) && !erased.has(e));
    const newPeople = fileEmails.filter((e) => !onList.has(e)).length;
    if (fileEmails.length + kept.length > LIST_VERSION_MAX_CONTACTS) {
      throw new BulkEmailError(
        "too_many",
        hidden
          ? "This file cannot be added to this list. Import it into a new list instead."
          : `Adding these would put this list over ${LIST_VERSION_MAX_CONTACTS.toLocaleString("en-US")} contacts. Import them into a new list instead.`,
        400,
      );
    }
    const emails = [...fileEmails, ...kept];
    const mixed = current.mixed || (current.versionId !== null && current.fromDatabase !== (args.sourceKind === "database"));
    const names = [...fileNames, ...kept.map(() => null)];
    const out = (await rpc(args.tenantId, "email_list_import_version", {
      p_list_id: args.listId ?? null,
      p_list_name: args.listId ? null : cleanListName(args.name),
      p_source_kind: current.fromDatabase ? "database" : args.sourceKind,
      p_source_ref: mixed ? { ...(args.sourceRef ?? {}), mixed: MIXED_SOURCES } : (args.sourceRef ?? {}),
      p_emails: emails,
      p_created_by: args.userId,
      ...(withNames ? { p_names: names } : {}),
      ...(current.versionId ? { p_base_version_id: current.versionId } : {}),
    })) as {
      ok?: boolean;
      reason?: string;
      list_id?: string;
      version_id?: string;
      contact_count?: number;
      already_blocked?: number;
      new_count?: number;
      new_blocked?: number;
    } | null;
    if (out?.reason === "list_changed" && attempt < IMPORT_ATTEMPTS) continue;
    if (!out?.ok || !out.list_id || !out.version_id) {
      const [status, message] = IMPORT_REFUSALS[out?.reason ?? ""] ?? STORE_ERROR;
      throw new BulkEmailError(out?.reason ?? "bulk_store_error", message, status);
    }
    if (hidden) return { list_id: out.list_id, version_id: out.version_id, received: true, membership_hidden: true };
    const added = args.listId ? Number(out.new_count ?? newPeople) : Number(out.contact_count ?? fileEmails.length);
    return {
      list_id: out.list_id,
      version_id: out.version_id,
      added,
      invalid: cleaned.invalid,
      duplicates: cleaned.duplicates,
      over_limit: cleaned.over_limit,
      already_unsubscribed: Math.min(added, Number((args.listId ? out.new_blocked : out.already_blocked) ?? 0)),
      skipped_erased: skippedErased,
    };
  }
}

const CONSENT_REFUSALS: Record<string, [number, string]> = {
  not_a_member: [403, "You are not a member of this workspace."],
  not_authorized: [403, "Only a workspace owner or admin can confirm consent for a list."],
  list_not_found: [404, "That contact list was not found."],
  version_not_found: [404, "That import was not found."],
  already_recorded: [409, "Consent was already confirmed for this import."],
  superseded: [409, "A newer import replaced this one. Confirm consent for the newest import."],
};

export async function recordListConsent(args: {
  tenantId: string;
  userId: string;
  listId: string;
  versionId: string;
}): Promise<{ active_version_id: string }> {
  const out = (await rpc(args.tenantId, "email_list_record_consent", {
    p_list_id: args.listId,
    p_version_id: args.versionId,
    p_user_id: args.userId,
    p_consent_text: CONSENT_SENTENCE,
  })) as { ok?: boolean; reason?: string; active_version_id?: string } | null;
  if (!out?.ok || !out.active_version_id) {
    const [status, message] = CONSENT_REFUSALS[out?.reason ?? ""] ?? STORE_ERROR;
    throw new BulkEmailError(out?.reason ?? "bulk_store_error", message, status);
  }
  return { active_version_id: out.active_version_id };
}

export type ListVersionSummary = {
  id: string;
  source_kind: "csv" | "database";
  source_label: string | null;
  mixed?: boolean;
  contact_count: number;
  created_at: string;
  consented: boolean;
};

export type ListSummary = {
  id: string;
  name: string;
  created_at: string;
  latest: ListVersionSummary | null;
  active: {
    id: string;
    source_kind: "csv" | "database";
    contact_count: number;
    sendable: number;
    unsubscribed_or_bounced: number;
  } | null;
  needs_consent: boolean;
};

type RawSummary = {
  id: string;
  name: string;
  created_at: string;
  active_version_id: string | null;
  latest: {
    id: string;
    source_kind: "csv" | "database";
    source_ref?: { table?: unknown; column?: unknown; mixed?: unknown } | null;
    contact_count: number;
    created_at: string;
    consented: boolean;
  } | null;
  active: { id: string; source_kind?: "csv" | "database"; contact_count: number; blocked: number } | null;
};

function sourceLabel(ref: { table?: unknown; column?: unknown } | null | undefined): string | null {
  const column = typeof ref?.column === "string" && ref.column.trim() ? ref.column.trim() : null;
  const table = typeof ref?.table === "string" && ref.table.trim() ? ref.table.trim() : null;
  if (!column) return null;
  return table ? `${table}.${column}` : column;
}

const ERASED_ID_BATCH = 100;

async function erasedByVersion(tenantId: string, versionIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (versionIds.length === 0) return counts;
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db.from("email_contacts").select("id").not("erased_at", "is", null);
    if (error) return counts;
    const ids = ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
    for (let i = 0; i < ids.length; i += ERASED_ID_BATCH) {
      const { data: held, error: heldError } = await db
        .from("email_list_version_contacts")
        .select("version_id")
        .in("version_id", versionIds)
        .in("contact_id", ids.slice(i, i + ERASED_ID_BATCH));
      if (heldError) return new Map();
      for (const m of (held ?? []) as Array<{ version_id: string }>) counts.set(m.version_id, (counts.get(m.version_id) ?? 0) + 1);
    }
    return counts;
  } catch {
    return new Map();
  }
}

export async function listSummaries(tenantId: string): Promise<ListSummary[]> {
  const rows = ((await rpc(tenantId, "email_list_summaries", {})) ?? []) as RawSummary[];
  const versionIds = [...new Set(rows.flatMap((r) => [r.active?.id, r.latest?.id]).filter((id): id is string => !!id))];
  const erased = await erasedByVersion(tenantId, versionIds);
  return rows.map((r) => {
    const blocked = Number(r.active?.blocked ?? 0);
    const count = Number(r.active?.contact_count ?? 0);
    const erasedActive = r.active ? (erased.get(r.active.id) ?? 0) : 0;
    return {
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      latest: r.latest
        ? {
            id: r.latest.id,
            source_kind: r.latest.source_kind,
            source_label: isMixedRef(r.latest.source_ref) ? null : sourceLabel(r.latest.source_ref),
            mixed: isMixedRef(r.latest.source_ref),
            contact_count: Math.max(0, Number(r.latest.contact_count ?? 0) - (erased.get(r.latest.id) ?? 0)),
            created_at: r.latest.created_at,
            consented: r.latest.consented === true,
          }
        : null,
      active: r.active
        ? {
            id: r.active.id,
            source_kind: r.active.source_kind === "database" ? "database" : "csv",
            contact_count: Math.max(0, count - erasedActive),
            sendable: Math.max(0, count - blocked),
            unsubscribed_or_bounced: Math.max(0, blocked - erasedActive),
          }
        : null,
      needs_consent: !!r.latest && r.latest.consented !== true,
    };
  });
}

export function isDatabaseList(l: ListSummary): boolean {
  return l.latest?.source_kind === "database" || l.active?.source_kind === "database";
}

export type ListSummaryView = Omit<ListSummary, "latest" | "active"> & {
  latest: (Omit<ListVersionSummary, "contact_count"> & { contact_count: number | null }) | null;
  active: { id: string; source_kind: "csv" | "database"; contact_count: number | null; sendable: number | null; unsubscribed_or_bounced: number | null } | null;
  members_hidden: boolean;
};

export function listSummariesFor(lists: ListSummary[], canSeeDatabaseAddresses: boolean): ListSummaryView[] {
  return lists.map((l) => {
    if (canSeeDatabaseAddresses || !isDatabaseList(l)) return { ...l, members_hidden: false };
    return {
      ...l,
      latest: l.latest ? { ...l.latest, contact_count: null } : null,
      active: l.active ? { ...l.active, contact_count: null, sendable: null, unsubscribed_or_bounced: null } : null,
      members_hidden: true,
    };
  });
}

export type ListContact = { id: string; email: string | null; status: string };

export async function listContactsPage(args: {
  tenantId: string;
  listId: string;
  limit: number;
  offset: number;
}): Promise<{ total: number; contacts: ListContact[]; version_id: string | null; source_kind: "csv" | "database" | null }> {
  const summary = (await listSummaries(args.tenantId)).find((l) => l.id === args.listId);
  if (!summary) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
  const versionId = summary.latest?.id ?? summary.active?.id ?? null;
  const source_kind = summary.latest?.source_kind ?? null;
  if (!versionId) return { total: 0, contacts: [], version_id: null, source_kind };
  const out = (await rpc(args.tenantId, "email_list_contacts_page", {
    p_list_id: args.listId,
    p_version_id: versionId,
    p_limit: args.limit,
    p_offset: args.offset,
  })) as { total?: number; contacts?: ListContact[] } | null;
  return { total: Number(out?.total ?? 0), contacts: out?.contacts ?? [], version_id: versionId, source_kind };
}

export type ImportCounts = {
  new: number;
  already_in_contacts: number;
  duplicate_in_file: number;
  bad: number;
  over_limit: number;
  already_on_list?: number;
  skipped_erased?: number;
  membership_hidden?: boolean;
};

export async function previewImportCounts(args: {
  tenantId: string;
  userId: string;
  listId?: string | null;
  values: readonly unknown[];
  cap: number;
  canSeeDatabaseAddresses?: boolean;
}): Promise<ImportCounts> {
  const cleaned = cleanAddresses(args.values, args.cap);
  if (args.listId) {
    await assertOpenList(args.tenantId, args.listId);
    const current = await currentListEmails(args.tenantId, args.listId);
    if (current.fromDatabase && args.canSeeDatabaseAddresses !== true) {
      return {
        new: cleaned.emails.length,
        already_in_contacts: 0,
        duplicate_in_file: cleaned.duplicates,
        bad: cleaned.invalid,
        over_limit: cleaned.over_limit,
        membership_hidden: true,
      };
    }
    const erased = await erasedAddresses(args.tenantId);
    const live = cleaned.emails.filter((e) => !erased.has(e));
    const onList = new Set(current.emails);
    const already = live.filter((e) => onList.has(e)).length;
    return {
      new: live.length - already,
      already_in_contacts: 0,
      already_on_list: already,
      skipped_erased: cleaned.emails.length - live.length,
      duplicate_in_file: cleaned.duplicates,
      bad: cleaned.invalid,
      over_limit: cleaned.over_limit,
    };
  }
  const erased = cleaned.emails.length > 0 ? await erasedAddresses(args.tenantId) : new Set<string>();
  const live = cleaned.emails.filter((e) => !erased.has(e));
  let existing = 0;
  if (live.length > 0) {
    const { data, error } = (await tenantRpc(asTenantId(args.tenantId), "email_contacts_existing_count", {
      p_user_id: args.userId,
      p_emails: live,
    })) as RpcResult;
    if (error) throw new BulkEmailError("bulk_store_error", "Something went wrong reading your contacts. Try again.", 500);
    existing = Math.min(live.length, Math.max(0, Number(data ?? 0)));
  }
  return {
    new: live.length - existing,
    already_in_contacts: existing,
    skipped_erased: cleaned.emails.length - live.length,
    duplicate_in_file: cleaned.duplicates,
    bad: cleaned.invalid,
    over_limit: cleaned.over_limit,
  };
}

export type Person = {
  id: string;
  email: string;
  masked: boolean;
  name: string | null;
  lists: { id: string; name: string }[];
  status: string;
  source: "csv" | "database" | "database_and_csv";
  added_at: string;
};

export type PeoplePage = {
  rows: Person[];
  total: number;
  counts: { contacts: number; lists: number; unsubscribed: number; bounced: number } | null;
  masked: boolean;
};

export async function listPeople(args: {
  tenantId: string;
  userId: string;
  search: string | null;
  listId: string | null;
  limit: number;
  offset: number;
}): Promise<PeoplePage> {
  const { data, error } = (await tenantRpc(asTenantId(args.tenantId), "email_contacts_people", {
    p_user_id: args.userId,
    p_search: args.search,
    p_list_id: args.listId,
    p_limit: args.limit,
    p_offset: args.offset,
  })) as RpcResult;
  if (error) throw new BulkEmailError("bulk_store_error", "Something went wrong reading your contacts. Try again.", 500);
  const out = data as { ok?: boolean; total?: unknown; rows?: unknown; counts?: Record<string, unknown> | null; masked?: unknown } | null;
  if (!out?.ok) throw new BulkEmailError("not_authorized", "You are not a member of this workspace.", 403);
  const c = out.counts;
  return {
    rows: (Array.isArray(out.rows) ? out.rows : []) as Person[],
    total: Number(out.total ?? 0),
    counts: c
      ? {
          contacts: Number(c.contacts ?? 0),
          lists: Number(c.lists ?? 0),
          unsubscribed: Number(c.unsubscribed ?? 0),
          bounced: Number(c.bounced ?? 0),
        }
      : null,
    masked: out.masked === true,
  };
}

export async function archiveList(tenantId: string, listId: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("email_lists")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", listId)
    .is("archived_at", null)
    .select("id");
  if (error) throw new BulkEmailError("bulk_store_error", "Something went wrong archiving that list. Try again.", 500);
  if (!Array.isArray(data) || data.length === 0) {
    throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
  }
}

const UNARCHIVE_REFUSALS: Record<string, [number, string]> = {
  not_authorized: [403, "Only a workspace owner or admin can unarchive a list."],
  list_not_found: [404, "That contact list was not found."],
  name_taken: [409, "Another list already uses this name. Archive that list first, then unarchive this one."],
};

export type UnarchiveResult = {
  unarchived: boolean;
  stopped_sends: number;
};

export async function unarchiveList(tenantId: string, listId: string, userId: string): Promise<UnarchiveResult> {
  const out = (await rpc(tenantId, "email_list_unarchive", { p_list_id: listId, p_user_id: userId })) as {
    ok?: boolean;
    reason?: string;
    unarchived?: boolean;
    stopped_sends?: number;
  } | null;
  if (!out?.ok) {
    const [status, message] = UNARCHIVE_REFUSALS[out?.reason ?? ""] ?? STORE_ERROR;
    throw new BulkEmailError(out?.reason ?? "bulk_store_error", message, status);
  }
  return { unarchived: out.unarchived === true, stopped_sends: Number(out.stopped_sends ?? 0) };
}

export type ArchivedList = { id: string; name: string; archived_at: string; people: number; from_database: boolean };

export async function archivedLists(tenantId: string): Promise<ArchivedList[]> {
  const rows = ((await rpc(tenantId, "email_list_archived_summaries", {})) ?? []) as ArchivedList[];
  return rows.map((r) => ({ ...r, people: Number(r.people ?? 0), from_database: r.from_database === true }));
}

export type ArchivedListView = Omit<ArchivedList, "people" | "from_database"> & { people: number | null; members_hidden: boolean };

export function archivedListsFor(lists: ArchivedList[], canSeeDatabaseAddresses: boolean): ArchivedListView[] {
  return lists.map(({ from_database, people, ...l }) => {
    const hidden = from_database && !canSeeDatabaseAddresses;
    return { ...l, people: hidden ? null : people, members_hidden: hidden };
  });
}

export async function eraseContact(tenantId: string, contactId: string): Promise<void> {
  const ok = await rpc(tenantId, "email_contact_erase", { p_contact_id: contactId });
  if (ok !== true) throw new BulkEmailError("contact_not_found", "That contact was not found.", 404);
}
