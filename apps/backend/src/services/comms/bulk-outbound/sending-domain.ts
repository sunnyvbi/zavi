
import { createHash } from "node:crypto";
import { FREE_MAILBOX_DOMAINS } from "@/email/free-mailbox-domains";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { bulkSendgridKey, requireBulkSendgridKey } from "./config";
import { BulkEmailError } from "./errors";
import { logEvent } from "@/services/logging/logEvent";

const SENDGRID_BASE = "https://api.sendgrid.com/v3";
const SENDGRID_TIMEOUT_MS = 15_000;
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type DnsRecord = { type: string; host: string; data: string };

export type SendingDomainView = {
  domain: string;
  status: "pending" | "verified" | "failed";
  from_address: string;
  dns_records: DnsRecord[];
  last_error: string | null;
  verified_at: string | null;
};

type Row = {
  domain: string;
  from_address: string | null;
  from_name: string | null;
  verification_status: string;
  verification_error: string | null;
  dns_records: unknown;
  provider_domain_id: string | null;
  verified_at: string | null;
  last_checked_at?: string | null;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type SendingDomainDeps = { fetch?: FetchLike };

export const DOMAIN_RECHECK_MS = 24 * 60 * 60 * 1000;

function zaviOwnDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = [env.ZAVI_EMAIL_FROM, env.AGENT_EMAIL_FROM, env.SYSTEM_EMAIL_FROM]
    .map((v) => (v ?? "").trim().toLowerCase().replace(/^.*@/, "").replace(/>.*$/, ""))
    .filter((d) => d.includes("."));
  return ["zaviagent.com", "thepraxis.ai", ...fromEnv];
}

export function isZaviDomain(host: string): boolean {
  return zaviOwnDomains().some((d) => host === d || host.endsWith(`.${d}`));
}

export function normalizeSendingDomain(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const host = text.replace(/^[a-z]+:\/\//, "").replace(/^.*@/, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!HOSTNAME_RE.test(host)) {
    throw new BulkEmailError("invalid_domain", "Enter a domain like example.com.");
  }
  if (isZaviDomain(host)) {
    throw new BulkEmailError("zavi_domain", "Use a domain your business owns. Zavi's own domains cannot be used.");
  }
  if (FREE_MAILBOX_DOMAINS.has(host)) {
    throw new BulkEmailError(
      "free_mailbox_domain",
      "Use a domain your business owns. A free mailbox address like Gmail or Outlook cannot be verified.",
    );
  }
  return host;
}

function fromAddressOf(row: Pick<Row, "domain" | "from_address">): string {
  return row.from_address?.trim() || `hello@${row.domain}`;
}

function toRecords(raw: unknown): DnsRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is DnsRecord => !!r && typeof r === "object" && typeof (r as DnsRecord).host === "string")
    .map((r) => ({ type: String(r.type ?? "").toUpperCase(), host: r.host, data: String(r.data ?? "") }));
}

function view(row: Row): SendingDomainView {
  const stored = row.verification_status === "verified" || row.verification_status === "failed" ? row.verification_status : "pending";
  const noProviderRecord = stored === "verified" && !row.provider_domain_id;
  return {
    domain: row.domain,
    status: noProviderRecord ? "pending" : stored,
    from_address: fromAddressOf(row),
    dns_records: toRecords(row.dns_records),
    last_error: noProviderRecord ? NO_PROVIDER_RECORD_ERROR : (row.verification_error ?? null),
    verified_at: noProviderRecord ? null : (row.verified_at ?? null),
  };
}

async function readRow(tenantId: string): Promise<Row | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_sending_domain")
    .select("domain, from_address, from_name, verification_status, verification_error, dns_records, provider_domain_id, verified_at, last_checked_at")
    .maybeSingle();
  if (error) throw new BulkEmailError("sending_domain_read_failed", "We could not read your sending domain. Try again.", 500);
  return (data as Row | null) ?? null;
}

export async function getSendingDomain(tenantId: string): Promise<SendingDomainView | null> {
  const row = await readRow(tenantId);
  return row ? view(row) : null;
}

export type BulkSender = { domain: string; from_address: string; from_name: string | null };

export async function resolveBulkSender(tenantId: string): Promise<BulkSender | null> {
  const row = await readRow(tenantId);
  if (!row || row.verification_status !== "verified" || !row.provider_domain_id || !row.domain?.trim()) return null;
  if (isZaviDomain(row.domain.trim().toLowerCase())) return null;
  const from = fromAddressOf(row);
  if (!from.toLowerCase().endsWith(`@${row.domain.toLowerCase()}`)) {
    return { domain: row.domain, from_address: `hello@${row.domain}`, from_name: row.from_name };
  }
  return { domain: row.domain, from_address: from, from_name: row.from_name };
}

async function sendgrid(
  deps: SendingDomainDeps,
  key: string,
  method: "POST" | "GET" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const doFetch = deps.fetch ?? (fetch as unknown as FetchLike);
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await doFetch(`${SENDGRID_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new BulkEmailError("email_provider_unreachable", "We could not reach the email provider. Try again in a minute.", 502);
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { ok: resp.ok, status: resp.status, body: parsed };
}

const DOMAIN_TAKEN = "This domain is already connected to another workspace.";

const FORBIDDEN = "Only a workspace owner or admin can set the sending domain.";

function environmentOrigin(): string | null {
  const url = process.env.SUPABASE_URL?.trim().toLowerCase().replace(/\/+$/, "");
  return url ? createHash("sha256").update(url).digest("hex").slice(0, 32) : null;
}

function withOrigin(records: DnsRecord[]): unknown[] {
  const origin = environmentOrigin();
  return origin ? [...records, { origin }] : records;
}

function createdHere(row: Pick<Row, "dns_records"> | null | undefined): boolean {
  const origin = environmentOrigin();
  if (!origin || !row || !Array.isArray(row.dns_records)) return false;
  return row.dns_records.some((r) => !!r && typeof r === "object" && (r as { origin?: unknown }).origin === origin);
}

async function logRecordNotOurs(id: string): Promise<void> {
  await logEvent({
    level: "warn",
    source: "bulk-email",
    code: "bulk_email.provider_record_not_ours",
    message: "a sending-domain record this environment did not create was left at the provider; it may belong to another environment",
    meta: { provider_domain_id: id },
  }).catch(() => undefined);
}

async function deleteProviderRecord(deps: SendingDomainDeps, key: string, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const r = await sendgrid(deps, key, "DELETE", `/whitelabel/domains/${encodeURIComponent(id)}`).catch(() => null);
  if (r && (r.ok || r.status === 404)) return;
  await logOrphanedRecord(id);
}

async function logOrphanedRecord(id: string): Promise<void> {
  await logEvent({
    level: "warn",
    source: "bulk-email",
    code: "bulk_email.provider_record_orphaned",
    message: "a sending-domain record could not be deleted at the provider; remove it by hand",
    meta: { provider_domain_id: id },
  }).catch(() => undefined);
}

async function checkDomainFree(tenantId: string, userId: string, domain: string): Promise<void> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "tenant_sending_domain_check", {
    p_user_id: userId,
    p_domain: domain,
  });
  if (error) throw new BulkEmailError("sending_domain_write_failed", "We could not save your sending domain. Try again.", 500);
  const out = data as { ok?: boolean; reason?: string } | null;
  if (out?.ok) return;
  if (out?.reason === "domain_taken") throw new BulkEmailError("domain_taken", DOMAIN_TAKEN, 409);
  if (out?.reason === "forbidden") throw new BulkEmailError("forbidden", FORBIDDEN, 403);
  throw new BulkEmailError("sending_domain_write_failed", "We could not save your sending domain. Try again.", 500);
}

async function upsertPending(
  tenantId: string,
  userId: string,
  domain: string,
  providerId: string,
  records: unknown[],
): Promise<{ releasedProviderId: string | null }> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "tenant_sending_domain_upsert_pending", {
    p_user_id: userId,
    p_domain: domain,
    p_provider_domain_id: providerId,
    p_dns_records: records,
  });
  if (error) throw new BulkEmailError("sending_domain_write_failed", "We could not save your sending domain. Try again.", 500);
  const out = data as { ok?: boolean; reason?: string; released_provider_domain_id?: string | null } | null;
  if (out?.ok) return { releasedProviderId: out.released_provider_domain_id ?? null };
  if (out?.reason === "domain_taken") throw new BulkEmailError("domain_taken", DOMAIN_TAKEN, 409);
  if (out?.reason === "forbidden") throw new BulkEmailError("forbidden", FORBIDDEN, 403);
  throw new BulkEmailError("sending_domain_write_failed", "We could not save your sending domain. Try again.", 500);
}

async function mirrorDomainSetting(tenantId: string, userId: string, domain: string): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenantId), "set_channel_settings", {
      p_channel_slug: "email_marketing",
      p_field_id: "sending_domain",
      p_items: [{ item: domain, item_type: null, status: null, position: 0, note: null, origin: null, detail: null }],
      p_actor_user_id: userId,
    });
  } catch {
  }
}

async function clearDomainSetting(tenantId: string, userId: string): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenantId), "set_channel_settings", {
      p_channel_slug: "email_marketing",
      p_field_id: "sending_domain",
      p_items: [],
      p_actor_user_id: userId,
    });
  } catch {
    return;
  }
}

function holdsUsableRecord(row: Row, domain: string): boolean {
  if (row.domain.toLowerCase() !== domain || !row.provider_domain_id) return false;
  if (row.verification_status === "verified") return true;
  if (row.verification_error === NO_PROVIDER_RECORD_ERROR || row.verification_error === DOMAIN_CHANGED_ERROR) return false;
  return toRecords(row.dns_records).length > 0;
}

export async function addSendingDomain(
  args: { tenantId: string; userId: string; domain: unknown },
  deps: SendingDomainDeps = {},
): Promise<SendingDomainView> {
  const key = requireBulkSendgridKey();
  const domain = normalizeSendingDomain(args.domain);

  const existing = await readRow(args.tenantId);
  if (existing && holdsUsableRecord(existing, domain)) {
    await mirrorDomainSetting(args.tenantId, args.userId, domain);
    return view(existing);
  }

  await checkDomainFree(args.tenantId, args.userId, domain);

  const r = await sendgrid(deps, key, "POST", "/whitelabel/domains", { domain, automatic_security: true, default: false });
  const id = r.body?.id;
  if (!r.ok || (typeof id !== "number" && typeof id !== "string")) {
    if (r.status === 401 || r.status === 403) {
      throw new BulkEmailError("bulk_sender_not_configured", "Bulk email is not set up yet.", 503);
    }
    if (r.status === 429 || r.status >= 500 || !r.body) {
      throw new BulkEmailError("email_provider_unreachable", "We could not reach the email provider. Try again in a minute.", 502);
    }
    throw new BulkEmailError("domain_setup_failed", "The email provider could not set up that domain. Check the spelling and try again.", 422);
  }
  const issued = Object.values((r.body?.dns ?? {}) as Record<string, { host?: string; type?: string; data?: string }>);
  const records: DnsRecord[] = issued
    .filter((d) => d && d.host && d.type && d.data)
    .map((d) => ({ type: String(d.type).toUpperCase(), host: String(d.host), data: String(d.data) }));
  if (records.length === 0 || records.length !== issued.length) {
    await deleteProviderRecord(deps, key, String(id));
    throw new BulkEmailError("domain_setup_failed", "The email provider did not return all the DNS records. Try again in a minute.", 502);
  }

  let releasedProviderId: string | null = null;
  let replaced: Row | null;
  try {
    replaced = await readRow(args.tenantId);
    if (replaced && holdsUsableRecord(replaced, domain)) {
      await deleteProviderRecord(deps, key, String(id));
      await mirrorDomainSetting(args.tenantId, args.userId, domain);
      return view(replaced);
    }
    ({ releasedProviderId } = await upsertPending(args.tenantId, args.userId, domain, String(id), withOrigin(records)));
  } catch (e) {
    await deleteProviderRecord(deps, key, String(id));
    throw e;
  }
  await mirrorDomainSetting(args.tenantId, args.userId, domain);
  if (replaced?.provider_domain_id && replaced.provider_domain_id !== String(id)) {
    if (createdHere(replaced)) await deleteProviderRecord(deps, key, replaced.provider_domain_id);
    else await logRecordNotOurs(replaced.provider_domain_id);
  }
  if (releasedProviderId) await logRecordNotOurs(releasedProviderId);
  const row = await readRow(args.tenantId);
  if (!row) throw new BulkEmailError("sending_domain_write_failed", "We could not save your sending domain. Try again.", 500);
  return view(row);
}

export async function removeSendingDomain(
  args: { tenantId: string; userId: string; onlyIfStale?: boolean },
  deps: SendingDomainDeps = {},
): Promise<{ released: boolean }> {
  const before = await readRow(args.tenantId).catch(() => null);
  const { data, error } = await tenantRpc(asTenantId(args.tenantId), "tenant_sending_domain_release", {
    p_user_id: args.userId,
    p_only_stale: args.onlyIfStale === true,
  });
  if (error) throw new BulkEmailError("sending_domain_write_failed", "We could not remove your sending domain. Try again.", 500);
  const out = data as { ok?: boolean; reason?: string; released?: boolean; provider_domain_id?: string | null } | null;
  if (!out?.ok) {
    if (out?.reason === "forbidden") throw new BulkEmailError("forbidden", FORBIDDEN, 403);
    throw new BulkEmailError("sending_domain_write_failed", "We could not remove your sending domain. Try again.", 500);
  }
  if (out.released && out.provider_domain_id) {
    const key = bulkSendgridKey();
    if (before?.provider_domain_id !== out.provider_domain_id || !createdHere(before)) await logRecordNotOurs(out.provider_domain_id);
    else if (key) await deleteProviderRecord(deps, key, out.provider_domain_id);
    else await logOrphanedRecord(out.provider_domain_id);
  }
  if (args.onlyIfStale !== true) await clearDomainSetting(args.tenantId, args.userId);
  return { released: out.released === true };
}

async function validateWithProvider(
  tenantId: string,
  row: Row,
  key: string,
  deps: SendingDomainDeps,
): Promise<"verified" | "pending" | "failed" | null> {
  const id = row.provider_domain_id;
  if (!id) {
    await writeNoProviderRecord(tenantId, row);
    return "pending";
  }
  const record = await sendgrid(deps, key, "GET", `/whitelabel/domains/${encodeURIComponent(id)}`);
  if (record.status === 401 || record.status === 403) {
    throw new BulkEmailError("bulk_sender_not_configured", "Bulk email is not set up yet.", 503);
  }
  if (record.status === 404) {
    await writeStatus(tenantId, row, "pending", NO_PROVIDER_RECORD_ERROR);
    return "pending";
  }
  if (!record.ok || !record.body) return null;
  const recordDomain = typeof record.body.domain === "string" ? record.body.domain.trim().toLowerCase() : "";
  if (!recordDomain) return null;
  if (recordDomain !== row.domain.trim().toLowerCase()) {
    await writeStatus(tenantId, row, "pending", DOMAIN_CHANGED_ERROR);
    return "pending";
  }
  const r = await sendgrid(deps, key, "POST", `/whitelabel/domains/${encodeURIComponent(id)}/validate`);
  if (!r.ok || typeof r.body?.valid !== "boolean") return null;
  const valid = r.body.valid === true;
  const outcome = valid ? "verified" : row.verification_status === "verified" || row.verification_status === "failed" ? "failed" : "pending";
  await writeStatus(
    tenantId,
    row,
    outcome,
    outcome === "verified" ? null : outcome === "failed" ? DNS_CHECK_FAILED_ERROR : "We could not find all the records yet. DNS changes can take up to a day. Check them and try again.",
  );
  return outcome;
}

export const DNS_CHECK_FAILED_ERROR =
  "This domain failed its DNS check: its records are no longer found. Check the DNS records, then press Check now.";

const NO_PROVIDER_RECORD_ERROR = "This domain is no longer set up with the email provider. Add it again.";

const DOMAIN_CHANGED_ERROR = "This domain changed. Add it again to get its records.";

async function writeNoProviderRecord(tenantId: string, row: Row): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_sending_domain")
    .update({ verification_status: "pending", verification_error: NO_PROVIDER_RECORD_ERROR, verified_at: null, last_checked_at: now, updated_at: now })
    .eq("domain", row.domain)
    .is("provider_domain_id", null);
  if (error) throw new BulkEmailError("sending_domain_write_failed", "We could not save the result. Try again.", 500);
}

async function writeStatus(tenantId: string, row: Row, status: "verified" | "pending" | "failed", error: string | null): Promise<void> {
  const { error: rpcError } = await tenantRpc(asTenantId(tenantId), "tenant_sending_domain_set_status", {
    p_provider_domain_id: row.provider_domain_id,
    p_domain: row.domain,
    p_status: status,
    p_error: error,
  });
  if (rpcError) throw new BulkEmailError("sending_domain_write_failed", "We could not save the result. Try again.", 500);
}

export async function recheckSendingDomainIfStale(
  tenantId: string,
  deps: SendingDomainDeps & { now?: () => number } = {},
): Promise<void> {
  const key = bulkSendgridKey();
  if (!key) return;
  const row = await readRow(tenantId);
  if (!row || row.verification_status !== "verified") return;
  const last = Date.parse(row.last_checked_at ?? row.verified_at ?? "");
  const now = deps.now ? deps.now() : Date.now();
  if (Number.isFinite(last) && now - last < DOMAIN_RECHECK_MS) return;
  try {
    await validateWithProvider(tenantId, row, key, deps);
  } catch (e) {
    if (e instanceof BulkEmailError && (e.code === "bulk_sender_not_configured" || e.code === "email_provider_unreachable")) return;
    throw e;
  }
}

export const PROVIDER_REFUSED_DOMAIN_ERROR =
  "The email provider refused mail from this address, and its records are not verified there any more. Check the DNS records, then press Check now.";

export async function markSendingDomainUnverified(
  tenantId: string,
  deps: SendingDomainDeps = {},
): Promise<"verified" | "failed" | "pending" | null> {
  const row = await readRow(tenantId);
  if (!row || row.verification_status !== "verified") return null;
  if (!row.provider_domain_id) {
    await writeNoProviderRecord(tenantId, row);
    return "pending";
  }
  const key = bulkSendgridKey();
  if (!key) return null;
  let r: Awaited<ReturnType<typeof sendgrid>>;
  try {
    r = await sendgrid(deps, key, "POST", `/whitelabel/domains/${encodeURIComponent(row.provider_domain_id)}/validate`);
  } catch {
    return null;
  }
  if (r.status === 404) {
    await writeStatus(tenantId, row, "pending", NO_PROVIDER_RECORD_ERROR);
    return "pending";
  }
  if (!r.ok || typeof r.body?.valid !== "boolean") return null;
  if (r.body.valid === true) return "verified";
  await writeStatus(tenantId, row, "failed", PROVIDER_REFUSED_DOMAIN_ERROR);
  return "failed";
}

export async function verifySendingDomain(
  args: { tenantId: string },
  deps: SendingDomainDeps = {},
): Promise<SendingDomainView> {
  const key = requireBulkSendgridKey();
  const row = await readRow(args.tenantId);
  if (!row) {
    throw new BulkEmailError("sending_domain_missing", "Add your sending domain first.", 404);
  }
  const outcome = await validateWithProvider(args.tenantId, row, key, deps);
  if (outcome === null) {
    throw new BulkEmailError("email_provider_unreachable", "We could not check your domain right now. Try again in a minute.", 502);
  }
  const after = await readRow(args.tenantId);
  if (!after) throw new BulkEmailError("sending_domain_missing", "Add your sending domain first.", 404);
  return view(after);
}
