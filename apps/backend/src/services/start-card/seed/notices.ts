
import { randomUUID } from "node:crypto";
import type { StartCardDiagnosisEvidence, StartCardProfileEvidence } from "@zavi/shared";
import { emailCanRemove } from "../report";
import { canonicalDomain } from "./store";

const ROLE_ORDER = ["hello", "hi", "contact", "info", "team", "founders", "founder", "sales", "support", "help", "general", "office", "mail"];
const NEVER = /^(no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster|abuse|security|privacy|legal|gdpr|dpo|compliance|jobs|careers|hiring|recruit\w*|talent|hr|billing|invoices?|accounts?|payments?|unsubscribe|example|test|admin|webmaster|root)$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|css|js)$/i;

export const CONTACT_PATHS = ["/", "/contact", "/contact-us", "/about", "/about-us", "/imprint", "/impressum", "/legal"];

export function emailsInHtml(html: string): string[] {
  const out = new Set<string>();
  const decoded = html.replace(/\s*(?:\[at\]|\(at\))\s*/gi, "@").replace(/&#64;|&#x40;/gi, "@").replace(/%40/g, "@");
  for (const m of decoded.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/^mailto:/, "").replace(/\.+$/, "");
    if (!ASSET_SUFFIX.test(e)) out.add(e);
  }
  return [...out];
}

export function usableContact(email: string, domain: string): boolean {
  const d = canonicalDomain(domain);
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  const host = email.slice(at + 1).toLowerCase();
  if (NEVER.test(local) || local.length > 64) return false;
  if (host !== d && !host.endsWith(`.${d}`)) return false;
  return emailCanRemove(email, d);
}

export function pickContact(emails: string[], domain: string): string | null {
  const local = (e: string) => e.slice(0, e.indexOf("@"));
  const ok = emails.filter((e) => usableContact(e, domain) && ROLE_ORDER.includes(local(e)));
  if (ok.length === 0) return null;
  return [...ok].sort((a, b) => ROLE_ORDER.indexOf(local(a)) - ROLE_ORDER.indexOf(local(b)))[0];
}

export type FetchText = (url: string, domain: string) => Promise<string | null>;

export async function discoverContact(domain: string, fetchText: FetchText): Promise<string | null> {
  const d = canonicalDomain(domain);
  const found: string[] = [];
  for (const path of CONTACT_PATHS) {
    const html = await fetchText(`https://${d}${path}`, d);
    if (!html) continue;
    found.push(...emailsInHtml(html));
    const best = pickContact(found, d);
    if (best) return best;
  }
  return pickContact(found, d);
}

export function newNoticeKey(): string {
  return `seed-notice-${randomUUID()}`;
}

export type NoticeCard = {
  id: string;
  public_id: string;
  domain: string;
  status: string;
  revoked_at: string | null;
  score: unknown;
  parts: Record<string, { state?: string; evidence?: unknown } | undefined> | null;
};

export type EnqueueDeps = {
  doneItems: (runId: string, after: string, limit: number) => Promise<Array<{ domain: string; card_id: string; source: "yc" | "product_hunt" }>>;
  hasNotice: (domain: string) => Promise<boolean>;
  discover: (domain: string) => Promise<string | null>;
  insertNotice: (row: { domain: string; card_id: string; email: string; idempotency_key: string }) => Promise<"inserted" | "exists">;
  markChecked: (runId: string, domain: string) => Promise<void>;
  log: (line: string) => void;
};

export async function enqueueNotices(runId: string, d: EnqueueDeps, opts: { limit: number; pageSize?: number }): Promise<{ queued: number; no_contact: number; existing: number }> {
  const sum = { queued: 0, no_contact: 0, existing: 0 };
  const page = opts.pageSize ?? 200;
  let after = "";
  for (;;) {
    const items = await d.doneItems(runId, after, page);
    for (const item of items) {
      if (sum.queued >= opts.limit) return sum;
      if (await d.hasNotice(item.domain)) {
        sum.existing++;
        await d.markChecked(runId, item.domain);
        continue;
      }
      const email = await d.discover(item.domain);
      if (!email) {
        sum.no_contact++;
        d.log(`[seed-notice] ${item.domain}: no role contact address; the card stays unlisted`);
        await d.markChecked(runId, item.domain);
        continue;
      }
      const r = await d.insertNotice({ domain: item.domain, card_id: item.card_id, email, idempotency_key: newNoticeKey() });
      if (r === "exists") sum.existing++;
      else sum.queued++;
      await d.markChecked(runId, item.domain);
    }
    if (items.length < page) return sum;
    after = items[items.length - 1].domain;
  }
}

export type ClaimOutcome =
  | { outcome: "claimed"; email: string; idempotency_key: string; card_id: string }
  | { outcome: "no_notice" | "not_pending" | "cancelled" | "day_cap" };

export type SendDeps = {
  pending: (limit: number) => Promise<Array<{ domain: string; source: "yc" | "product_hunt" | null }>>;
  sentToday: () => Promise<number>;
  claim: (domain: string) => Promise<ClaimOutcome>;
  getCard: (id: string) => Promise<NoticeCard | null>;
  send: (args: {
    email: string;
    domain: string;
    cardUrl: string;
    removeUrl: string;
    oneClickUrl: string;
    source: "yc" | "product_hunt" | null;
    card: { score: never; diagnosis: StartCardDiagnosisEvidence | null; companyName: string | null };
    noticeKey: string;
  }) => Promise<{ messageId: string }>;
  accepted: (domain: string, messageId: string) => Promise<string>;
  markFailed: (domain: string, state: "unknown" | "bounced", error: string) => Promise<void>;
  release: (domain: string, error: string) => Promise<void>;
  webBase: string;
  apiBase: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

function statusOf(e: unknown): number {
  return Number((e as { code?: unknown })?.code ?? (e as { response?: { statusCode?: unknown } })?.response?.statusCode);
}

export function definitelyRejected(e: unknown): boolean {
  const code = statusOf(e);
  return Number.isFinite(code) && code >= 400 && code < 500 && code !== 408 && code !== 429;
}

export function retryableRefusal(e: unknown): boolean {
  const code = statusOf(e);
  return code === 408 || code === 429;
}

export function noticeArgs(
  card: NoticeCard,
  o: { email: string; noticeKey: string; source: "yc" | "product_hunt" | null; webBase: string; apiBase: string },
): Parameters<SendDeps["send"]>[0] {
  const profile = card.parts?.profile?.state === "done" ? (card.parts.profile.evidence as StartCardProfileEvidence) : null;
  const diagnosis = card.parts?.diagnosis?.state === "done" ? (card.parts.diagnosis.evidence as StartCardDiagnosisEvidence) : null;
  const cardUrl = `${o.webBase}/r/${card.public_id}`;
  return {
    email: o.email,
    domain: card.domain,
    cardUrl,
    removeUrl: `${cardUrl}?remove=1`,
    oneClickUrl: `${o.apiBase}/api/public/seed-notice/unsubscribe?k=${encodeURIComponent(o.noticeKey)}`,
    source: o.source,
    card: { score: card.score as never, diagnosis, companyName: profile?.company_name ?? null },
    noticeKey: o.noticeKey,
  };
}

export async function sendNotices(
  d: SendDeps,
  opts: { limit: number; perDay: number; dryRun: boolean; gapMs: number },
): Promise<{ sent: number; skipped: number; failed: number; dry: number; stopped?: "per_day_cap" }> {
  const sum = { sent: 0, skipped: 0, failed: 0, dry: 0 } as { sent: number; skipped: number; failed: number; dry: number; stopped?: "per_day_cap" };
  const room = Math.max(0, opts.perDay - (await d.sentToday()));
  if (room === 0) return { ...sum, stopped: "per_day_cap" };
  const batch = await d.pending(Math.min(opts.limit, room));
  for (const n of batch) {
    if (opts.dryRun) {
      d.log(`[seed-notice] would send to ${n.domain}`);
      sum.dry++;
      continue;
    }
    const c = await d.claim(n.domain);
    if (c.outcome === "day_cap") return { ...sum, stopped: "per_day_cap" };
    if (c.outcome !== "claimed") {
      sum.skipped++;
      continue;
    }
    const card = await d.getCard(c.card_id);
    if (!card || card.revoked_at || card.status !== "done" || !card.score) {
      await d.markFailed(n.domain, "unknown", "card_not_showable_after_claim");
      sum.skipped++;
      continue;
    }
    let messageId: string;
    try {
      ({ messageId } = await d.send(noticeArgs(card, { email: c.email, noticeKey: c.idempotency_key, source: n.source, webBase: d.webBase, apiBase: d.apiBase })));
    } catch (e) {
      const msg = ((e as Error)?.message ?? "send_error").slice(0, 200);
      if (retryableRefusal(e)) await d.release(n.domain, msg);
      else await d.markFailed(n.domain, definitelyRejected(e) ? "bounced" : "unknown", msg);
      d.log(`[seed-notice] ${n.domain}: send failed (${msg})`);
      sum.failed++;
      continue;
    }
    sum.sent++;
    try {
      d.log(`[seed-notice] ${n.domain}: sent, ${await d.accepted(n.domain, messageId)}`);
    } catch (e) {
      d.log(`[seed-notice] ${n.domain}: SENT BUT NOT RECORDED (message ${messageId}): ${((e as Error)?.message ?? "").slice(0, 120)}`);
    }
    await d.sleep(opts.gapMs);
  }
  return sum;
}
