import type { BulkSendRow, BulkSendStatus, BulkSendStore, ClaimOutcome, FreezeResult, SendCounts } from "../store";

type Recipient = {
  contact_id: string;
  email: string;
  status: "pending" | "sending" | "sent" | "skipped" | "failed" | "unknown";
  skip_reason: string | null;
  stamped_at: number | null;
};

type Version = { tenantId: string; listId: string; emails: string[]; consented: boolean };

export class FakeLedger implements BulkSendStore {
  now = Date.parse("2026-10-07T12:00:00Z");
  decisions = new Map<string, { tenantId: string; approved_by: string | null }>();
  versions = new Map<string, Version>();
  archivedLists = new Set<string>();
  blocked = new Map<string, string>();
  erased = new Set<string>();
  counters = new Map<string, number>();
  warmup = new Map<string, { index: number; last: string }>();
  abuseHolds = new Set<string>();
  sends = new Map<string, BulkSendRow & { complaints: number; hard_bounces: number }>();
  recipients = new Map<string, Recipient[]>();
  private seq = 0;

  addVersion(id: string, v: Version): void {
    this.versions.set(id, v);
  }
  block(tenantId: string, email: string, reason = "unsubscribed"): void {
    this.blocked.set(`${tenantId}|${email}`, reason);
  }
  rows(sendId: string): Recipient[] {
    return this.recipients.get(sendId) ?? [];
  }
  statuses(sendId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows(sendId)) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  private own(tenantId: string, sendId: string) {
    const s = this.sends.get(sendId);
    return s && s.tenant_id === tenantId ? s : null;
  }

  async getSend(tenantId: string, sendId: string): Promise<BulkSendRow | null> {
    const s = this.own(tenantId, sendId);
    return s ? { ...s } : null;
  }

  async freeze(a: Parameters<BulkSendStore["freeze"]>[0]): Promise<FreezeResult> {
    for (const s of this.sends.values()) {
      if (s.decision_id === a.decisionId && s.tenant_id === a.tenantId) {
        return { ok: true, send_id: s.id, total: s.total, created: false };
      }
    }
    if (this.abuseHolds.has(a.tenantId)) return { ok: false, reason: "abuse_hold" };
    const d = this.decisions.get(a.decisionId);
    if (!d || d.tenantId !== a.tenantId || !d.approved_by) return { ok: false, reason: "not_approved" };
    if (this.archivedLists.has(a.listId)) return { ok: false, reason: "list_archived" };
    const v = this.versions.get(a.versionId);
    if (!v || v.tenantId !== a.tenantId || v.listId !== a.listId || !v.consented) {
      return { ok: false, reason: "version_not_consented" };
    }
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    const frozen: Recipient[] = [...v.emails]
      .sort()
      .filter((e) => !this.erased.has(`c:${e}`))
      .slice(0, Math.min(a.cap, 1000))
      .map((email) => ({ contact_id: `c:${email}`, email, status: "pending", skip_reason: null, stamped_at: null }));
    this.recipients.set(id, frozen);
    this.sends.set(id, {
      id,
      tenant_id: a.tenantId,
      decision_id: a.decisionId,
      list_id: a.listId,
      list_version_id: a.versionId,
      subject: a.subject,
      body_text: a.bodyText,
      body_html: a.bodyHtml ?? null,
      render_sha: a.renderSha ?? null,
      from_address: a.fromAddress,
      reply_to: a.replyTo,
      total: frozen.length,
      status: "sending",
      hold_reason: null,
      next_run_at: null,
      complaints: 0,
      hard_bounces: 0,
    });
    return { ok: true, send_id: id, total: frozen.length, created: true };
  }

  async markStaleUnknown(tenantId: string, sendId: string, staleSeconds: number): Promise<number> {
    if (!this.own(tenantId, sendId)) return 0;
    let n = 0;
    for (const r of this.rows(sendId)) {
      if (r.status === "sending" && (r.stamped_at ?? 0) <= this.now - staleSeconds * 1000) {
        r.status = "unknown";
        n += 1;
      }
    }
    return n;
  }

  async claimNext(tenantId: string, sendId: string, dailyCap: number): Promise<ClaimOutcome> {
    if (!Number.isInteger(dailyCap) || dailyCap < 0) throw new Error("email_bulk_claim_next: invalid argument");
    const s = this.own(tenantId, sendId);
    if (!s || s.status !== "sending" || this.abuseHolds.has(tenantId)) return { outcome: "held" };
    const v = this.versions.get(s.list_version_id);
    if (this.archivedLists.has(s.list_id) || !v || !v.consented) return { outcome: "held" };
    const r = this.rows(sendId).find((x) => x.status === "pending");
    if (!r) return { outcome: "none_pending" };
    const reason = this.erased.has(r.contact_id) ? "erased" : this.blocked.get(`${tenantId}|${r.email}`);
    if (reason) {
      r.status = "skipped";
      r.skip_reason = reason;
      r.stamped_at = this.now;
      return { outcome: "skipped", reason };
    }
    const day = new Date(this.now).toISOString().slice(0, 10);
    const domain = s.from_address.split("@")[1]!.toLowerCase();
    const wkey = `${tenantId}|${domain}`;
    const w = this.warmup.get(wkey);
    const day_index = !w ? 0 : w.last < day ? w.index + 1 : w.index;
    const warm = day_index >= 10 ? 0 : 50 * 2 ** day_index;
    const cap = warm > 0 && dailyCap > 0 ? Math.min(warm, dailyCap) : warm > 0 ? warm : dailyCap;
    const key = `${tenantId}|${day}`;
    const used = this.counters.get(key) ?? 0;
    if (cap > 0 && used + 1 > cap) return { outcome: "allowance_exhausted", day_index };
    this.counters.set(key, used + 1);
    r.status = "sending";
    r.stamped_at = this.now;
    return { outcome: "claimed", contact_id: r.contact_id, email: r.email, day_index };
  }

  private touchWarmup(tenantId: string, sendId: string): void {
    const s = this.sends.get(sendId)!;
    const day = new Date(this.now).toISOString().slice(0, 10);
    const wkey = `${tenantId}|${s.from_address.split("@")[1]!.toLowerCase()}`;
    const w = this.warmup.get(wkey);
    this.warmup.set(wkey, { index: !w ? 0 : w.last < day ? w.index + 1 : w.index, last: day });
  }

  async requeueClaimed(tenantId: string, sendId: string, contactId: string): Promise<boolean> {
    if (!this.own(tenantId, sendId)) return false;
    const r = this.rows(sendId).find((x) => x.contact_id === contactId);
    if (!r || r.status !== "sending") return false;
    r.status = "pending";
    return true;
  }

  erase(tenantId: string, contactId: string): void {
    this.erased.add(contactId);
    for (const [sendId, rows] of this.recipients) {
      if (this.sends.get(sendId)?.tenant_id !== tenantId) continue;
      for (const r of rows) {
        if (r.contact_id === contactId && (r.status === "pending" || r.status === "sending")) {
          r.status = "skipped";
          r.skip_reason = "erased";
        }
      }
    }
  }

  async skipIfBlocked(tenantId: string, sendId: string, contactId: string): Promise<string | null> {
    if (!this.own(tenantId, sendId)) return "not_found";
    const r = this.rows(sendId).find((x) => x.contact_id === contactId);
    if (!r) return "not_found";
    if (r.status === "skipped") return r.skip_reason ?? "skipped";
    if (r.status !== "sending") return "not_claimed";
    const reason = this.erased.has(r.contact_id) ? "erased" : this.blocked.get(`${tenantId}|${r.email}`) ?? null;
    if (reason) {
      r.status = "skipped";
      r.skip_reason = reason;
    }
    return reason;
  }

  async settleRecipient(tenantId: string, sendId: string, contactId: string, status: "sent" | "failed" | "unknown"): Promise<boolean> {
    if (!this.own(tenantId, sendId)) return false;
    const r = this.rows(sendId).find((x) => x.contact_id === contactId);
    if (!r) return false;
    if (
      r.status === "sending" ||
      (r.status === "unknown" && status !== "unknown") ||
      (r.status === "skipped" && r.skip_reason === "erased")
    ) {
      r.skip_reason = null;
      r.status = status;
      if (status === "sent" || status === "unknown") this.touchWarmup(tenantId, sendId);
      r.stamped_at = this.now;
      return true;
    }
    return false;
  }

  async sendIdForDecision(tenantId: string, decisionId: string): Promise<string | null> {
    for (const s of this.sends.values()) if (s.tenant_id === tenantId && s.decision_id === decisionId) return s.id;
    return null;
  }

  async closeHeldSend(tenantId: string, sendId: string): Promise<boolean> {
    const s = this.own(tenantId, sendId);
    if (!s || s.status !== "held") return false;
    if (this.rows(sendId).some((r) => r.status === "sent" || r.status === "unknown" || r.status === "sending")) return false;
    s.status = "failed";
    return true;
  }

  async settleSend(
    tenantId: string,
    sendId: string,
    status: BulkSendStatus | null,
    holdReason: string | null = null,
    nextRunAt: string | null = null,
  ): Promise<SendCounts> {
    const s = this.own(tenantId, sendId);
    if (!s) throw new Error("email_bulk_settle_send: send not found");
    const c = this.statuses(sendId);
    const isAbuse = (r: string | null) => r === "abuse_complaints" || r === "abuse_bounces";
    if (status === "held" && isAbuse(holdReason)) this.abuseHolds.add(tenantId);
    const open = s.status !== "done" && s.status !== "failed";
    const nobodyLeft = (c.pending ?? 0) === 0 && (c.sending ?? 0) === 0;
    if (open && nobodyLeft && ((status === "held" && isAbuse(holdReason)) || (s.status === "held" && isAbuse(s.hold_reason)))) {
      s.status = "done";
      s.hold_reason = null;
      s.next_run_at = null;
    }
    const closed = s.status === "done" || s.status === "failed" || s.status === "held";
    if (status && !closed) {
      s.status = status;
      if (status === "held") s.hold_reason = holdReason;
      s.next_run_at = status === "waiting_for_tomorrow" ? nextRunAt : null;
    }
    return {
      status: s.status,
      hold_reason: s.hold_reason,
      next_run_at: s.next_run_at,
      total: s.total,
      sent: c.sent ?? 0,
      skipped: c.skipped ?? 0,
      failed: c.failed ?? 0,
      unknown: c.unknown ?? 0,
      pending: c.pending ?? 0,
      sending: c.sending ?? 0,
      complaints: s.complaints,
      hard_bounces: s.hard_bounces,
    };
  }
}
