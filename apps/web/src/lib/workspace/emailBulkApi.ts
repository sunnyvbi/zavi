
import { apiFetch } from "@/lib/api";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

export class EmailBulkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EmailBulkError";
  }
}

const FALLBACK = "Something went wrong. Try again.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    throw new EmailBulkError("network", "We could not reach Zavi. Check your connection and try again.", 0);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    throw new EmailBulkError(body?.error?.code ?? "error", body?.error?.message ?? FALLBACK, res.status);
  }
  return body as T;
}

export type DnsRecord = { type: string; host: string; data: string };

export type SendingDomain = {
  domain: string;
  status: "pending" | "verified" | "failed";
  from_address: string;
  dns_records: DnsRecord[];
  last_error: string | null;
  verified_at: string | null;
};

export type SendingDomainState = {
  domain: SendingDomain | null;
  suggested_domain: string | null;
  can_manage: boolean;
  bulk_email_ready: boolean;
  postal_address_set: boolean;
};

let domainRead: Promise<SendingDomainState> | null = null;
export const getSendingDomain = (): Promise<SendingDomainState> =>
  (domainRead ??= request<SendingDomainState>("/api/workspace/sending-domain").finally(() => {
    domainRead = null;
  }));

export async function addSendingDomain(domain: string): Promise<SendingDomain> {
  const out = await request<{ domain: SendingDomain }>("/api/workspace/sending-domain", {
    method: "POST",
    body: JSON.stringify({ domain }),
  });
  return out.domain;
}

export async function saveSendingDomainSetting(domain: string): Promise<void> {
  await request<unknown>("/api/channels/email_marketing/settings/sending_domain", {
    method: "PUT",
    body: JSON.stringify({ items: domain.trim() ? [domain.trim()] : [] }),
  });
}

export const removeSendingDomain = () =>
  request<{ released: boolean }>("/api/workspace/sending-domain", { method: "DELETE" });

export async function verifySendingDomain(): Promise<SendingDomain> {
  const out = await request<{ domain: SendingDomain }>("/api/workspace/sending-domain/verify", { method: "POST" });
  return out.domain;
}

export type ContactList = {
  id: string;
  name: string;
  created_at: string;
  latest: {
    id: string;
    source_kind: "csv" | "database";
    source_label: string | null;
    mixed?: boolean;
    contact_count: number | null;
    created_at: string;
    consented: boolean;
  } | null;
  active: { id: string; contact_count: number | null; sendable: number | null; unsubscribed_or_bounced: number | null } | null;
  needs_consent: boolean;
  members_hidden?: boolean;
};

export async function getContactLists(): Promise<ContactList[]> {
  return (await request<{ lists: ContactList[] }>("/api/workspace/email-lists")).lists;
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

export type CsvPreview = {
  columns: Array<{ header: string; samples: string[]; has_addresses: boolean }>;
  auto_column: string | null;
  row_count: number;
  preview_rows?: string[][];
  counts?: ImportCounts;
};

export type CsvMapping = { column: string; firstColumn?: string | null; lastColumn?: string | null; fullColumn?: string | null; listId?: string | null };

export type ImportResult = {
  list_id: string | null;
  version_id: string | null;
  added: number;
  invalid: number;
  duplicates: number;
  over_limit: number;
  already_unsubscribed: number;
  skipped_erased?: number;
  notice?: string;
};

export type ImportReceived = { list_id: string; version_id: string; received: true; membership_hidden: true; notice?: string };

export type ImportOutcome = ImportResult | ImportReceived;

export const isImportReceived = (r: ImportOutcome): r is ImportReceived => (r as ImportReceived).received === true;

function form(file: File, fields: Record<string, string | null | undefined>): FormData {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
  return fd;
}

export const previewCsv = (file: File, mapping?: CsvMapping) =>
  request<CsvPreview>("/api/workspace/email-lists/preview-csv", {
    method: "POST",
    body: form(
      file,
      mapping
        ? { column: mapping.column, first_column: mapping.firstColumn, last_column: mapping.lastColumn, full_column: mapping.fullColumn, list_id: mapping.listId }
        : {},
    ),
  });

export const importCsv = (args: {
  file: File;
  column: string;
  name?: string;
  listId?: string;
  firstColumn?: string | null;
  lastColumn?: string | null;
  fullColumn?: string | null;
}) =>
  request<ImportOutcome>("/api/workspace/email-lists/import-csv", {
    method: "POST",
    body: form(args.file, {
      column: args.column,
      name: args.name,
      list_id: args.listId,
      first_column: args.firstColumn,
      last_column: args.lastColumn,
      full_column: args.fullColumn,
    }),
  }).finally(forgetEmailTestLists);

export type Person = {
  id: string;
  email: string;
  masked: boolean;
  name: string | null;
  lists: Array<{ id: string; name: string }>;
  status: string;
  source: "csv" | "database" | "database_and_csv";
  added_at: string;
};

export type ContactCounts = { contacts: number; lists: number; unsubscribed: number; bounced: number };

export type PeoplePage = { rows: Person[]; total: number; counts: ContactCounts | null; masked: boolean };

export async function getEmailContacts(args: { search?: string; listId?: string; offset?: number; limit?: number } = {}): Promise<PeoplePage> {
  const q = new URLSearchParams();
  if (args.search?.trim()) q.set("search", args.search.trim());
  if (args.listId) q.set("list_id", args.listId);
  q.set("offset", String(args.offset ?? 0));
  q.set("limit", String(args.limit ?? 50));
  const r = await request<Partial<PeoplePage>>(`/api/workspace/email-contacts?${q.toString()}`);
  const c: Partial<ContactCounts> | null = r?.counts ?? null;
  return {
    rows: Array.isArray(r?.rows) ? r.rows : [],
    total: typeof r?.total === "number" ? r.total : 0,
    counts: c ? { contacts: c.contacts ?? 0, lists: c.lists ?? 0, unsubscribed: c.unsubscribed ?? 0, bounced: c.bounced ?? 0 } : null,
    masked: r?.masked === true,
  };
}

export type ImportTable = { name: string; column_count: number };

export async function getImportTables(): Promise<ImportTable[] | null> {
  try {
    return (await request<{ tables: ImportTable[] }>("/api/workspace/operator-db/tables")).tables;
  } catch (e) {
    if (e instanceof EmailBulkError && e.code === "database_not_connected") return null;
    throw e;
  }
}

export async function getImportColumns(table: string): Promise<Array<{ name: string; type: string }>> {
  const out = await request<{ columns: Array<{ name: string; type: string }> }>(
    `/api/workspace/operator-db/tables/${encodeURIComponent(table)}/columns`,
  );
  return out.columns;
}

export const importDatabase = (args: { table: string; column: string; name?: string; listId?: string }) =>
  request<ImportOutcome>("/api/workspace/email-lists/import-database", {
    method: "POST",
    body: JSON.stringify({ table: args.table, column: args.column, name: args.name, list_id: args.listId }),
  }).finally(forgetEmailTestLists);

export const confirmListConsent = (listId: string, versionId: string) =>
  request<{ active_version_id: string }>(`/api/workspace/email-lists/${listId}/versions/${versionId}/consent`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  }).finally(forgetEmailTestLists);

export async function getListSamples(listId: string): Promise<string[]> {
  const out = await request<{ contacts: Array<{ email: string | null }> }>(
    `/api/workspace/email-lists/${listId}/contacts?limit=5`,
  );
  return out.contacts.map((c) => c.email).filter((e): e is string => !!e);
}

export const archiveContactList = (listId: string) =>
  request<{ ok: true }>(`/api/workspace/email-lists/${listId}`, { method: "DELETE" }).finally(forgetEmailTestLists);

export const eraseEmailContact = (contactId: string) =>
  request<{ ok: true }>(`/api/workspace/email-contacts/${encodeURIComponent(contactId)}`, { method: "DELETE" }).finally(forgetEmailTestLists);

export type ArchivedContactList = {
  id: string;
  name: string;
  archived_at: string;
  people: number | null;
  members_hidden: boolean;
};

export async function getArchivedContactLists(): Promise<ArchivedContactList[]> {
  return (await request<{ lists?: ArchivedContactList[] }>("/api/workspace/email-lists/archived")).lists ?? [];
}

export type UnarchiveOutcome = { ok: true; unarchived: boolean; stopped_sends: number };

export const unarchiveContactList = (listId: string) =>
  request<UnarchiveOutcome>(`/api/workspace/email-lists/${listId}/unarchive`, { method: "POST" }).finally(forgetEmailTestLists);

export const CONSENT_SENTENCE = "These people agreed to hear from me.";

export function importSummary(r: ImportOutcome): string {
  if (isImportReceived(r)) return "Import received.";
  const n = (v: number) => v.toLocaleString("en-US");
  const parts = [`Added ${n(r.added)} ${r.added === 1 ? "contact" : "contacts"}.`];
  if (r.duplicates > 0) parts.push(`${n(r.duplicates)} repeated ${r.duplicates === 1 ? "address was" : "addresses were"} left out.`);
  if (r.invalid > 0) parts.push(`${n(r.invalid)} ${r.invalid === 1 ? "row was" : "rows were"} not an email address.`);
  if (r.over_limit > 0) parts.push(`${n(r.over_limit)} did not fit: a list holds up to 10,000.`);
  if (r.already_unsubscribed > 0) {
    parts.push(`${n(r.already_unsubscribed)} already unsubscribed or bounced, so ${r.already_unsubscribed === 1 ? "it" : "they"} will be skipped.`);
  }
  if ((r.skipped_erased ?? 0) > 0) parts.push(`${n(r.skipped_erased ?? 0)} skipped because ${r.skipped_erased === 1 ? "it was" : "they were"} erased.`);
  if (r.notice) parts.push(r.notice);
  return parts.join(" ");
}

export type Suppression = { email: string; reason: string; created_at: string };

export type SuppressionPage = { rows: Suppression[]; total: number; page: number; page_size: number; masked: boolean };

export const getEmailSuppressions = (args: { search?: string; page?: number } = {}) =>
  request<Partial<SuppressionPage>>(
    `/api/workspace/email-suppressions?search=${encodeURIComponent(args.search ?? "")}&page=${args.page ?? 1}`,
  ).then(
    (r): SuppressionPage => ({
      rows: Array.isArray(r?.rows) ? r.rows : [],
      total: typeof r?.total === "number" ? r.total : 0,
      page: typeof r?.page === "number" ? r.page : (args.page ?? 1),
      page_size: typeof r?.page_size === "number" && r.page_size > 0 ? r.page_size : 50,
      masked: r?.masked === true,
    }),
  );

export const addEmailSuppression = (email: string) =>
  request<{ added: boolean; email: string; reason: string; created_at: string }>("/api/workspace/email-suppressions", { method: "POST", body: JSON.stringify({ email }) });
