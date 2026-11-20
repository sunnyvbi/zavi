
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "./alias";
import type { SiteNoticeMailer } from "./mailer";
import type { FormNoticeRow, ShardHandle, SiteAuthDirectory } from "./types";

export const FORM_NOTIFY_LIMITED_RETRY_S = 15 * 60;
export const FORM_NOTIFY_LEASE_S = 120;
export const FORM_NOTIFY_BATCH = 100;
export const FORM_NOTIFY_MAX_ROUNDS = 50;
export const FORM_NOTIFY_SHARD_BUDGET_MS = 60_000;
export const FORM_NOTIFY_BACKLOG_ALERT_S = 60 * 60;
export const FORM_NOTIFY_BACKLOG_ALERT_EVERY_S = 60 * 60;
export const DIGEST_OVER = 3;
export const DIGEST_MAX_RECORDS = 10;
const MAX_FIELDS = 20;
const MAX_VALUE_CHARS = 1000;

export interface FormNotifyTarget {
  tenantId: string;
  ownerEmail: string | null;
  hostname: string;
  name: string | null;
  status: string;
  muted: boolean;
  version: number;
}

export interface FormNotifyDeps {
  directory: SiteAuthDirectory;
  target(siteId: string): Promise<FormNotifyTarget | null>;
  tenantOwnerEmail(tenantId: string): Promise<string | null>;
  mailer: SiteNoticeMailer;
  unsubscribeUrl(siteId: string, recipient: string, version: number): string | null;
  alert?: (msg: string, code: string) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export type DrainTally = { sent: number; records: number; dropped: number; deferred: number; failed: number; lost: number; rounds: number };

function logEvent(deps: FormNotifyDeps, event: string, fields: Record<string, unknown>): void {
  deps.log?.(`[site-form-notify] ${JSON.stringify({ event, ...fields })}`);
}

async function alertOnce(deps: FormNotifyDeps, msg: string, code: string): Promise<void> {
  try {
    await deps.alert?.(msg, code);
  } catch (e) {
    logEvent(deps, "alert_failed", { code, error: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}

export async function drainFormNotifications(deps: FormNotifyDeps, shard: ShardHandle, max = FORM_NOTIFY_BATCH): Promise<DrainTally> {
  const tally: DrainTally = { sent: 0, records: 0, dropped: 0, deferred: 0, failed: 0, lost: 0, rounds: 0 };
  const now = deps.now ?? (() => Date.now());

  for (const p of await shard.store.formNotifyPurge(1000)) {
    logEvent(deps, "purged", { shard: shard.shardId, reason: p.reason, count: p.n });
    if (p.n > 0) {
      tally.lost += p.n;
      await alertOnce(deps, `site form emails: ${p.n} submission notice(s) on shard ${shard.shardId} were never mailed (${p.reason}); the submissions are saved on the site's admin page`, `sites.form_notify.${p.reason}`);
    }
  }
  const backlog = await shard.store.formNotifyBacklog();
  if (backlog.pending > 0 && backlog.oldestAgeS > FORM_NOTIFY_BACKLOG_ALERT_S) {
    logEvent(deps, "backlog", { shard: shard.shardId, pending: backlog.pending, oldest_age_s: backlog.oldestAgeS });
    if (await shard.store.rateTake("formnotify:backlog_alert", FORM_NOTIFY_BACKLOG_ALERT_EVERY_S, 1))
      await alertOnce(deps, `site form emails: ${backlog.pending} pending on shard ${shard.shardId}, oldest ${Math.round(backlog.oldestAgeS / 60)} min old`, "sites.form_notify.backlog");
  }
  const started = now();
  while (tally.rounds < FORM_NOTIFY_MAX_ROUNDS && now() - started < FORM_NOTIFY_SHARD_BUDGET_MS) {
    const rows = await shard.store.formNotifyClaim(max, FORM_NOTIFY_LEASE_S);
    tally.rounds++;
    if (!rows.length) break;
    const bySite = new Map<string, FormNoticeRow[]>();
    for (const r of rows) bySite.set(r.siteId, [...(bySite.get(r.siteId) ?? []), r]);
    for (const [siteId, notices] of bySite) await drainSite(deps, shard, siteId, notices, tally);
  }
  return tally;
}

const leasesOf = (ns: FormNoticeRow[]) => ns.map((n) => ({ id: n.id, leaseToken: n.leaseToken }));

async function drainSite(deps: FormNotifyDeps, shard: ShardHandle, siteId: string, notices: FormNoticeRow[], tally: DrainTally): Promise<void> {
  const ev = (event: string, count: number, extra: Record<string, unknown> = {}) =>
    logEvent(deps, event, { shard: shard.shardId, site_id: siteId, count, ...extra });
  const drop = async (reason: string) => {
    const n = await shard.store.formNotifyDone(leasesOf(notices));
    tally.dropped += n;
    ev("dropped", n, { reason });
  };
  const retry = (reason: string) => {
    tally.failed += notices.length;
    ev("retry_later", notices.length, { reason });
  };
  let pending = notices;
  try {
    const target = await deps.target(siteId);
    if (!target) return void (await drop("not_a_zavi_site"));
    if (target.muted) return void (await drop("owner_opted_out"));
    const site = await deps.directory.site(siteId);
    if (!site) return retry("site_unresolved");
    if (site.shardId !== shard.shardId) return void (await drop("site_not_on_shard"));
    if (!site.active) return void (await drop("site_not_live"));
    const to = normalizeEmail(target.ownerEmail ?? "") || normalizeEmail((await deps.tenantOwnerEmail(target.tenantId)) ?? "");
    if (!to) return retry("no_owner_email");

    const siteName = (target.name || site.name || site.hostname).slice(0, 60);
    const unsub = deps.unsubscribeUrl(siteId, to, target.version);
    const headers = unsub ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
    const batches = notices.length > DIGEST_OVER ? [notices] : notices.map((n) => [n]);
    for (const batch of batches) {
      const mail = renderFormDigest({ siteName, hostname: site.hostname, notices: batch, unsubscribeUrl: unsub });
      const res = await deps.mailer.sendNotice(shard.store, { site: { ...site, name: siteName }, to, subject: mail.subject, html: mail.html, text: mail.text, headers });
      if (res === "limited") {
        const n = await shard.store.formNotifyDefer(leasesOf(pending), FORM_NOTIFY_LIMITED_RETRY_S);
        tally.deferred += n;
        ev("deferred", n, { reason: "site_mail_budget" });
        pending = [];
        return;
      }
      pending = pending.filter((n) => !batch.includes(n));
      tally.sent++;
      tally.records += batch.length;
      ev("sent", batch.length);
      try {
        const n = await shard.store.formNotifyDone(leasesOf(batch));
        if (n < batch.length) ev("done_lease_lost", batch.length - n);
      } catch (e) {
        ev("done_failed", batch.length, { error: String((e as Error)?.message ?? e).slice(0, 160) });
      }
    }
  } catch (e) {
    tally.failed += pending.length;
    ev("send_failed", pending.length, { error: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function label(k: string): string {
  const s = k.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : k;
}

function adminReadable(fields: Record<string, unknown>, key: string): boolean {
  const m = fields[key];
  if (!m || typeof m !== "object") return true;
  const read = (m as { read?: unknown }).read;
  return !Array.isArray(read) || read.includes("admin");
}

function valueText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() ? v.slice(0, MAX_VALUE_CHARS) : null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.filter((x) => ["string", "number", "boolean"].includes(typeof x)).map(String);
    return parts.length ? parts.join(", ").slice(0, MAX_VALUE_CHARS) : null;
  }
  return null;
}

export function submissionFields(n: Pick<FormNoticeRow, "data" | "fields">): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(n.data)) {
    if (out.length >= MAX_FIELDS) break;
    if (!adminReadable(n.fields, k)) continue;
    const t = valueText(v);
    if (t !== null) out.push([label(k), t]);
  }
  return out;
}

export function renderFormDigest(input: {
  siteName: string;
  hostname: string;
  notices: FormNoticeRow[];
  unsubscribeUrl: string | null;
}): { subject: string; html: string; text: string } {
  const name = input.siteName.replace(/[\r\n]+/g, " ").slice(0, 60);
  const n = input.notices.length;
  const subject = (n === 1 ? `New form submission on ${name}` : `${n} new form submissions on ${name}`).replace(/[\r\n]/g, " ");
  const admin = `https://${input.hostname}/admin?from=zavi`;
  const shown = input.notices.slice(0, DIGEST_MAX_RECORDS);
  const more = n - shown.length;

  const htmlItems = shown
    .map((r) => {
      const rows = submissionFields(r)
        .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0;white-space:pre-wrap">${esc(v)}</td></tr>`)
        .join("");
      return `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin:10px 0">
<p style="margin:0 0 6px;color:#666;font-size:13px">${esc(label(r.collection))} &middot; ${esc(r.createdAt.slice(0, 16).replace("T", " "))} UTC</p>
<table style="border-collapse:collapse;font-size:14px">${rows || '<tr><td style="color:#666">(no fields)</td></tr>'}</table></div>`;
    })
    .join("");
  const moreLine = more > 0 ? `<p>And ${more} more.</p>` : "";
  const unsubHtml = input.unsubscribeUrl
    ? ` <a href="${esc(input.unsubscribeUrl)}" style="color:#666">Stop these emails</a>.`
    : "";
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">
<p style="font-weight:600">${esc(name)}</p>
<p>${n === 1 ? "Someone sent a form on your site." : `${n} people sent forms on your site.`}</p>
${htmlItems}${moreLine}
<p><a href="${esc(admin)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">See all in your admin page</a></p>
<p style="color:#666;font-size:13px">You get this because you own ${esc(name)}.${unsubHtml}</p></div>`;

  const textItems = shown
    .map((r) => [`${label(r.collection)} (${r.createdAt.slice(0, 16).replace("T", " ")} UTC)`, ...submissionFields(r).map(([k, v]) => `${k}: ${v}`)].join("\n"))
    .join("\n\n");
  const text = [
    n === 1 ? `Someone sent a form on ${name}.` : `${n} people sent forms on ${name}.`,
    textItems,
    more > 0 ? `And ${more} more.` : "",
    `See all in your admin page: ${admin}`,
    input.unsubscribeUrl ? `Stop these emails: ${input.unsubscribeUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { subject, html, text };
}

export type OptOutAction = "mute" | "resume";
export const OPT_OUT_TTL_S: Record<OptOutAction, number> = { mute: 180 * 86400, resume: 30 * 86400 };
const TOKEN_CONTEXT = "site-form-notify:v2:";

export type OptOutClaims = { s: string; r: string; a: OptOutAction; v: number; e: number };

function keyOk(key: string): void {
  if (typeof key !== "string" || key.length < 32) throw new Error("form notify key is not configured");
}

export function recipientTag(key: string, email: string): string {
  keyOk(key);
  return createHmac("sha256", key).update(`${TOKEN_CONTEXT}rcpt:${(normalizeEmail(email) ?? "").toLowerCase()}`).digest("base64url").slice(0, 22);
}

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(TOKEN_CONTEXT + body).digest("base64url");
}

export function mintOptOutToken(
  key: string,
  input: { siteId: string; recipient: string; action: OptOutAction; version: number; nowS: number },
): string {
  keyOk(key);
  const claims: OptOutClaims = {
    s: input.siteId,
    r: recipientTag(key, input.recipient),
    a: input.action,
    v: input.version,
    e: Math.floor(input.nowS) + OPT_OUT_TTL_S[input.action],
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(key, body)}`;
}

export function readOptOutToken(key: string, token: string, nowS: number): OptOutClaims | null {
  if (typeof key !== "string" || key.length < 32 || typeof token !== "string" || token.length > 512) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(token.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let c: OptOutClaims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OptOutClaims;
  } catch {
    return null;
  }
  if (!c || typeof c.s !== "string" || typeof c.r !== "string" || (c.a !== "mute" && c.a !== "resume")) return null;
  if (!Number.isSafeInteger(c.v) || c.v < 0 || !Number.isSafeInteger(c.e) || c.e <= nowS) return null;
  return c;
}

export function formNotifyUnsubscribeUrl(
  apiBase: string | null | undefined,
  key: string,
  input: { siteId: string; recipient: string; version: number; nowS: number },
): string | null {
  const base = (apiBase ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return null;
  try {
    return `${base}/api/public/site-forms/unsubscribe?t=${mintOptOutToken(key, { ...input, action: "mute" })}`;
  } catch {
    return null;
  }
}
