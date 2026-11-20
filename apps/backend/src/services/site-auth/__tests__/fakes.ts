
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GoTrueEmailThrottled, SiteAuthError } from "../errors";
import type {
  AliasResolution,
  ClaimOutcome,
  ConfirmBegin,
  FormNoticeLease,
  FormNoticeRow,
  GoTrue,
  GoTrueSession,
  IdentityRow,
  MailRequest,
  MemberRow,
  OutboxRow,
  ShardHandle,
  ShardStore,
  SiteAuthDirectory,
  SiteMailer,
  SiteRecord,
  SubmissionStatRow,
  SubmissionWindow,
  VerifyType,
} from "../types";

type State = IdentityRow["state"];
interface Ident { siteId: string; email: string; uid: string; alias: string; state: State }
interface Member { siteId: string; uid: string; role: string; status: string; createdAt: number }
interface Change {
  id: string; siteId: string; uid: string; oldEmail: string; newEmail: string; newAlias: string;
  sha: string; state: string; expiresAt: number;
}
interface Signup {
  siteId: string; email: string; uid: string; alias: string; state: "pending" | "creating" | "quarantined";
  leaseSha: string | null; leaseUntil: number | null; lastChallengeAt: number | null; expiresAt: number;
}
interface Challenge { id: string; siteId: string; email: string; sha: string; expiresAt: number }
interface Outbox { id: string; siteId: string; to: string; kind: OutboxRow["kind"]; challengeId: string | null; leaseUntil: number | null; attempts: number }
export interface Audit { siteId: string; actor: string | null; action: string; target: string | null; detail: Record<string, unknown> }

const ROLE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class FakeStore implements ShardStore {
  sites = new Map<string, "active" | "suspended">();
  roles = new Map<string, string[]>();
  idents: Ident[] = [];
  members: Member[] = [];
  changes: Change[] = [];
  signups: Signup[] = [];
  challenges: Challenge[] = [];
  outbox: Outbox[] = [];
  receipts = new Map<string, { siteId: string; uid: string; alias: string; expiresAt: number }>();
  audit: Audit[] = [];
  epochs = new Map<string, number>();
  deletions = new Map<string, string>();
  records: Array<{ siteId: string; owner: string | null; id: string; collection?: string }> = [];
  objects: Array<{ name: string; owner: string | null }> = [];
  counters = new Map<string, number>();
  calls: string[] = [];
  private seq = 0;
  private outboxSeq = 0;
  constructor(public now: () => number) {}

  tick(): number {
    this.seq += 1;
    return this.now() / 1000 + this.seq * 1e-6;
  }

  private open(c: Change) { return c.state === "pending" || c.state === "committing"; }
  private member(siteId: string, uid: string) { return this.members.find((m) => m.siteId === siteId && m.uid === uid); }
  private ident(siteId: string, uid: string) { return this.idents.find((i) => i.siteId === siteId && i.uid === uid); }
  private bump(siteId: string, uid: string) {
    const k = `${siteId}:${uid}`;
    this.epochs.set(k, Math.max(this.epochs.get(k) ?? 0, this.tick()));
  }
  epochOf(siteId: string, uid: string): number | null { return this.epochs.get(`${siteId}:${uid}`) ?? null; }
  private isActiveAdmin(siteId: string, uid: string) {
    const m = this.member(siteId, uid);
    const i = this.ident(siteId, uid);
    return !!m && !!i && m.role === "admin" && m.status === "active" &&
      (i.state === "active" || i.state === "email_change_pending") && this.sites.get(siteId) === "active";
  }
  private adminCount(siteId: string) {
    return this.members.filter((m) => m.siteId === siteId && this.isActiveAdmin(siteId, m.uid)).length;
  }
  private guard(siteId: string, actor: string) {
    if (!this.isActiveAdmin(siteId, actor)) throw new SiteAuthError("member_admin_required");
  }
  private assertRole(siteId: string, role: string) {
    if (!ROLE_RE.test(role)) throw new SiteAuthError("invalid_role");
    if (role === "admin" || role === "user") return;
    if (!(this.roles.get(siteId) ?? []).includes(role)) throw new SiteAuthError("invalid_role");
  }
  private notLastAdmin(siteId: string, uid: string) {
    if (this.isActiveAdmin(siteId, uid) && this.adminCount(siteId) <= 1) throw new SiteAuthError("last_admin");
  }
  private row(i: Ident): IdentityRow {
    const m = this.member(i.siteId, i.uid);
    return {
      siteId: i.siteId, emailNorm: i.email, alias: i.alias, state: i.state, role: m?.role ?? null,
      memberStatus: m?.status ?? null, sessionsValidAfter: this.epochOf(i.siteId, i.uid),
    };
  }
  private memberRow(siteId: string, uid: string): MemberRow {
    const m = this.member(siteId, uid)!;
    const i = this.ident(siteId, uid)!;
    return {
      user_id: uid, email: i.email, role: m.role, status: (i.state === "unverified" ? "invited" : m.status) as MemberRow["status"],
      created_at: new Date(m.createdAt).toISOString(),
    };
  }
  private target(siteId: string, uid: string) {
    const m = this.member(siteId, uid);
    const i = this.ident(siteId, uid);
    if (!m || !i || i.state === "deleting") throw new SiteAuthError("member_not_found");
    return { m, i };
  }
  private log(siteId: string, actor: string | null, action: string, target: string | null, detail: Record<string, unknown> = {}) {
    this.audit.push({ siteId, actor, action, target, detail });
  }

  async identityByUser(uid: string) {
    const i = this.idents.find((x) => x.uid === uid);
    return i ? this.row(i) : null;
  }
  async identityByEmail(siteId: string, email: string) {
    const i = this.idents.find((x) => x.siteId === siteId && x.email === email);
    return i ? { ...this.row(i), authUserId: i.uid } : null;
  }
  async resolveAlias(alias: string): Promise<AliasResolution[]> {
    const out: AliasResolution[] = this.idents
      .filter((i) => i.alias === alias.toLowerCase())
      .map((i) => ({ siteId: i.siteId, authUserId: i.uid, emailNorm: i.email, kind: "current", state: i.state }));
    for (const c of this.changes) {
      if (c.newAlias === alias.toLowerCase() && this.open(c)) {
        out.push({ siteId: c.siteId, authUserId: c.uid, emailNorm: c.newEmail, kind: "pending_change", state: c.state });
      }
    }
    return out;
  }

  async signupRequest(a0: Parameters<ShardStore["signupRequest"]>[0]) {
    let a = a0;
    this.calls.push("signupRequest");
    const { siteId, email } = a;
    if (email !== email.toLowerCase().trim()) throw new Error("email_not_normalized");
    if (this.sites.get(siteId) !== "active") return;
    const id = this.idents.find((i) => i.siteId === siteId && i.email === email);
    if (id && id.state !== "pending" && id.state !== "unverified") {
      if (id.state === "active" || id.state === "email_change_pending") {
        this.outbox.push({ id: String(++this.outboxSeq), siteId, to: email, kind: "account_exists", challengeId: null, leaseUntil: null, attempts: 0 });
      }
      return;
    }
    if (id && id.state === "unverified") a = { ...a, uid: id.uid, alias: id.alias };
    if (this.changes.some((c) => c.siteId === siteId && c.newEmail === email && this.open(c))) return;
    const now = this.now();
    let s = this.signups.find((x) => x.siteId === siteId && x.email === email);
    if (!s) {
      s = { siteId, email, uid: a.uid, alias: a.alias.toLowerCase(), state: "pending", leaseSha: null, leaseUntil: null, lastChallengeAt: null, expiresAt: now + a.ttlSeconds * 1000 };
      this.signups.push(s);
    }
    if (s.state !== "pending") return;
    this.challenges = this.challenges.filter((c) => !(c.siteId === siteId && c.email === email && c.expiresAt <= now));
    if (this.challenges.filter((c) => c.siteId === siteId && c.email === email).length >= a.maxLive) return;
    if (s.lastChallengeAt !== null && s.lastChallengeAt > now - a.cooldownSeconds * 1000) return;
    this.challenges.push({ id: a.challengeId, siteId, email, sha: a.tokenSha256, expiresAt: now + a.ttlSeconds * 1000 });
    s.lastChallengeAt = now;
    s.expiresAt = Math.max(s.expiresAt, now + a.ttlSeconds * 1000);
    this.outbox.push({ id: String(++this.outboxSeq), siteId, to: email, kind: "verify_signup", challengeId: a.challengeId, leaseUntil: null, attempts: 0 });
  }
  async signupConfirmBegin(siteId: string, tokenSha: string, lease: number): Promise<ConfirmBegin> {
    const c = this.challenges.find((x) => x.sha === tokenSha);
    if (!c) {
      const r = this.receipts.get(tokenSha);
      if (r && r.siteId === siteId && r.expiresAt > this.now()) return { outcome: "done", authUserId: r.uid, alias: r.alias };
      return { outcome: "invalid" };
    }
    if (c.siteId !== siteId) return { outcome: "invalid" };
    const s = this.signups.find((x) => x.siteId === c.siteId && x.email === c.email);
    const now = this.now();
    if (!s || s.state === "quarantined") return { outcome: "invalid" };
    if (c.expiresAt <= now) return { outcome: "expired" };
    if (this.idents.some((i) => i.siteId === s.siteId && i.email === s.email &&
        !(i.state === "pending" || (i.state === "unverified" && i.uid === s.uid)))) return { outcome: "invalid" };
    if (s.state === "creating" && s.leaseSha !== tokenSha && (s.leaseUntil ?? 0) > now) return { outcome: "busy" };
    s.state = "creating"; s.leaseSha = tokenSha; s.leaseUntil = now + lease * 1000;
    return { outcome: "ok", authUserId: s.uid, email: s.email, alias: s.alias };
  }
  async signupConfirmRelease(siteId: string, tokenSha: string) {
    const s = this.signups.find((x) => x.siteId === siteId && x.state === "creating" && x.leaseSha === tokenSha);
    if (!s) return false;
    s.state = "pending"; s.leaseSha = null; s.leaseUntil = null;
    return true;
  }
  async signupQuarantine(siteId: string, tokenSha: string) {
    const s = this.signups.find((x) => x.siteId === siteId && x.state === "creating" && x.leaseSha === tokenSha);
    if (!s) return false;
    s.state = "quarantined"; s.leaseUntil = null;
    return true;
  }
  async signupConfirmFinish(siteId: string, tokenSha: string) {
    this.calls.push("signupConfirmFinish");
    const s = this.signups.find((x) => x.siteId === siteId && x.state === "creating" && x.leaseSha === tokenSha);
    if (!s) {
      const r = this.receipts.get(tokenSha);
      return r && r.siteId === siteId && r.expiresAt > this.now() ? ("done" as const) : ("invalid" as const);
    }
    const own = this.idents.find((i) => i.siteId === s.siteId && i.email === s.email &&
      (i.state === "pending" || (i.state === "unverified" && i.uid === s.uid)));
    if (own) {
      own.uid = s.uid; own.alias = s.alias; own.state = "active";
    } else if (this.idents.some((i) => (i.siteId === s.siteId && i.email === s.email) || i.uid === s.uid || i.alias === s.alias)) {
      s.state = "quarantined"; s.leaseUntil = null;
      return "conflict" as const;
    } else {
      this.idents.push({ siteId: s.siteId, email: s.email, uid: s.uid, alias: s.alias, state: "active" });
    }
    if (!this.member(s.siteId, s.uid)) this.members.push({ siteId: s.siteId, uid: s.uid, role: "user", status: "active", createdAt: this.now() });
    this.receipts.set(tokenSha, { siteId: s.siteId, uid: s.uid, alias: s.alias, expiresAt: this.now() + 10 * 60 * 1000 });
    this.dropSignup(s.siteId, s.email);
    return "ok" as const;
  }
  private dropSignup(siteId: string, email: string) {
    this.signups = this.signups.filter((x) => !(x.siteId === siteId && x.email === email));
    this.challenges = this.challenges.filter((x) => !(x.siteId === siteId && x.email === email));
  }
  async signupPurge(limit: number) {
    const now = this.now();
    this.challenges = this.challenges.filter((c) => c.expiresAt > now);
    const gone = this.signups
      .filter((s) => s.expiresAt <= now && (s.leaseUntil === null || s.leaseUntil <= now) &&
        !this.challenges.some((c) => c.siteId === s.siteId && c.email === s.email))
      .slice(0, limit);
    this.signups = this.signups.filter((s) => !gone.includes(s));
    return gone.filter((s) => s.state === "creating").map((s) => ({ siteId: s.siteId, authUserId: s.uid, alias: s.alias }));
  }
  async outboxClaim(limit: number, lease: number): Promise<OutboxRow[]> {
    const now = this.now();
    const live = (o: Outbox) =>
      (o.leaseUntil === null || o.leaseUntil <= now) && o.attempts < 5 &&
      (o.kind !== "verify_signup" || this.challenges.some((c) => c.id === o.challengeId && c.expiresAt > now));
    const picked = this.outbox.filter(live).slice(0, limit);
    for (const o of picked) { o.leaseUntil = now + lease * 1000; o.attempts += 1; }
    return picked.map((o) => ({ id: o.id, siteId: o.siteId, to: o.to, kind: o.kind, challengeId: o.challengeId }));
  }
  async outboxDefer(id: string, seconds: number) {
    const o = this.outbox.find((x) => x.id === id);
    if (!o) return false;
    o.leaseUntil = this.now() + seconds * 1000;
    o.attempts = Math.max(o.attempts - 1, 0);
    return true;
  }
  notices: Array<FormNoticeRow & { leaseUntil: number | null; attempts: number }> = [];
  async formNotifyClaim(limit: number, lease: number): Promise<FormNoticeRow[]> {
    const now = this.now();
    const picked = this.notices.filter((n) => (n.leaseUntil === null || n.leaseUntil <= now) && n.attempts < 8).slice(0, limit);
    for (const n of picked) { n.leaseUntil = now + Math.min(Math.max(lease, 5), 600) * 1000; n.attempts += 1; n.leaseToken = randomUUID(); }
    return picked.map(({ leaseUntil: _l, attempts: _a, ...row }) => ({ ...row }));
  }

  private held = (ls: FormNoticeLease[], x: { id: string; leaseToken: string }) => ls.some((l) => l.id === x.id && l.leaseToken === x.leaseToken);
  purgeResult: Array<{ reason: string; n: number }> = [];
  async formNotifyPurge(_limit: number) {
    const r = this.purgeResult;
    this.purgeResult = [];
    return r;
  }
  async formNotifyBacklog() {
    const now = this.now();
    const oldest = Math.min(...this.notices.map((n) => Date.parse(n.createdAt)), now);
    return { pending: this.notices.length, oldestAgeS: this.notices.length ? Math.floor((now - oldest) / 1000) : 0 };
  }
  async formNotifyDone(leases: FormNoticeLease[]) {
    const n = this.notices.length;
    this.notices = this.notices.filter((x) => !this.held(leases, x));
    return n - this.notices.length;
  }
  submissionRows: SubmissionStatRow[] = [];
  async submissionStats(_siteId: string, _w: SubmissionWindow) {
    return this.submissionRows;
  }
  async formNotifyDefer(leases: FormNoticeLease[], seconds: number) {
    let n = 0;
    for (const x of this.notices) {
      if (!this.held(leases, x)) continue;
      x.leaseToken = "";
      x.leaseUntil = this.now() + seconds * 1000;
      x.attempts = Math.max(x.attempts - 1, 0);
      n++;
    }
    return n;
  }
  async outboxDone(id: string) {
    const n = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.id !== id);
    return this.outbox.length < n;
  }

  async provisionIdentity(siteId: string, email: string, alias: string, uid: string) {
    if (this.sites.get(siteId) !== "active") return { outcome: "site_unavailable" as const };
    const i = this.idents.find((x) => x.siteId === siteId && x.email === email);
    if (i) return { outcome: "exists" as const, authUserId: i.uid, state: i.state };
    if (this.changes.some((c) => c.siteId === siteId && c.newEmail === email && this.open(c))) return { outcome: "reserved" as const };
    const s = this.signups.find((x) => x.siteId === siteId && x.email === email);
    const id = s?.uid ?? uid;
    this.dropSignup(siteId, email);
    this.idents.push({ siteId, email, uid: id, alias: alias.toLowerCase(), state: "unverified" });
    this.members.push({ siteId, uid: id, role: "user", status: "active", createdAt: this.now() });
    return { outcome: "created" as const, authUserId: id, state: "unverified" as const };
  }
  async bootstrapAdmin(siteId: string, uid: string) {
    const i = this.ident(siteId, uid);
    if (!i || !["unverified", "active", "email_change_pending"].includes(i.state)) throw new SiteAuthError("member_not_found");
    if (this.isActiveAdmin(siteId, uid)) return true;
    if (this.adminCount(siteId) > 0) throw new SiteAuthError("admin_exists");
    if (i.state === "unverified") i.state = "active";
    const m = this.member(siteId, uid)!;
    m.role = "admin"; m.status = "active";
    this.log(siteId, null, "bootstrap_admin", uid);
    return true;
  }
  async revokeSessions(siteId: string, uid: string) {
    if (!this.ident(siteId, uid)) return false;
    this.bump(siteId, uid);
    return true;
  }
  async memberInviteReserve(siteId: string, actor: string, email: string, alias: string, uid: string, role: string) {
    this.guard(siteId, actor);
    this.assertRole(siteId, role);
    let out: { outcome: "create" | "exists" | "held"; authUserId: string | null };
    const i = this.idents.find((x) => x.siteId === siteId && x.email === email);
    if (i) {
      if (i.state === "unverified") {
        const m = this.member(siteId, i.uid)!;
        m.role = role; m.status = "active";
        out = { outcome: "create", authUserId: i.uid };
      } else {
        if ((i.state === "active" || i.state === "email_change_pending") && !this.member(siteId, i.uid)) {
          this.members.push({ siteId, uid: i.uid, role, status: "active", createdAt: this.now() });
        }
        out = { outcome: "exists", authUserId: i.uid };
      }
    } else if (this.changes.some((c) => c.siteId === siteId && c.newEmail === email && this.open(c))) {
      out = { outcome: "held", authUserId: null };
    } else {
      const s = this.signups.find((x) => x.siteId === siteId && x.email === email);
      if (s && s.state === "creating" && (s.leaseUntil ?? 0) > this.now()) {
        out = { outcome: "held", authUserId: null };
      } else {
        const id = s?.uid ?? uid;
        this.dropSignup(siteId, email);
        this.idents.push({ siteId, email, uid: id, alias: alias.toLowerCase(), state: "unverified" });
        this.members.push({ siteId, uid: id, role, status: "active", createdAt: this.now() });
        out = { outcome: "create", authUserId: id };
      }
    }
    this.log(siteId, actor, "invite", out.outcome === "held" ? null : out.authUserId, { email_sha256: sha(email), role, outcome: out.outcome });
    return out;
  }
  async memberInviteFinish(siteId: string, actor: string, uid: string) {
    this.guard(siteId, actor);
    const i = this.ident(siteId, uid);
    if (i?.state === "unverified") {
      i.state = "active";
      this.log(siteId, actor, "invite_activated", uid);
    }
    return !!i && (i.state === "active" || i.state === "email_change_pending");
  }
  async memberList(siteId: string, actor: string, cursor: string | null, limit: number) {
    this.guard(siteId, actor);
    this.log(siteId, actor, "list", null);
    return this.members
      .filter((m) => m.siteId === siteId && this.ident(siteId, m.uid)?.state !== "deleting" && (cursor === null || m.uid > cursor))
      .sort((a, b) => (a.uid < b.uid ? -1 : 1))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map((m) => this.memberRow(siteId, m.uid));
  }
  async memberSetRole(siteId: string, actor: string, uid: string, role: string) {
    this.guard(siteId, actor);
    this.assertRole(siteId, role);
    const { m } = this.target(siteId, uid);
    if (m.role !== role) {
      if (m.role === "admin") this.notLastAdmin(siteId, uid);
      const from = m.role;
      m.role = role;
      this.bump(siteId, uid);
      this.log(siteId, actor, "set_role", uid, { from, to: role });
    }
    return this.memberRow(siteId, uid);
  }
  async memberDisable(siteId: string, actor: string, uid: string) {
    this.guard(siteId, actor);
    const { m } = this.target(siteId, uid);
    if (m.status !== "disabled") {
      this.notLastAdmin(siteId, uid);
      m.status = "disabled";
      this.bump(siteId, uid);
      this.log(siteId, actor, "disable", uid, { role: m.role });
    }
    return this.memberRow(siteId, uid);
  }
  async memberEnable(siteId: string, actor: string, uid: string) {
    this.guard(siteId, actor);
    const { m } = this.target(siteId, uid);
    if (m.status !== "active") {
      m.status = "active";
      this.log(siteId, actor, "enable", uid, { role: m.role });
    }
    return this.memberRow(siteId, uid);
  }
  async memberRemoveBegin(siteId: string, actor: string, uid: string) {
    this.guard(siteId, actor);
    const i = this.ident(siteId, uid);
    if (i && i.state !== "deleting" && !this.member(siteId, uid)) return true;
    const { m } = this.target(siteId, uid);
    this.notLastAdmin(siteId, uid);
    this.members = this.members.filter((x) => x !== m);
    this.bump(siteId, uid);
    this.log(siteId, actor, "remove", uid, { role: m.role });
    return true;
  }
  async memberReassignRecord(siteId: string, actor: string, collection: string, recordId: string, to: string) {
    this.guard(siteId, actor);
    const tm = this.member(siteId, to);
    const ti = this.ident(siteId, to);
    if (!tm || !ti || tm.status !== "active" || !(ti.state === "active" || ti.state === "email_change_pending")) throw new SiteAuthError("member_not_found");
    const r = this.records.find((x) => x.siteId === siteId && (x.collection ?? "notes") === collection && x.id === recordId);
    if (!r) throw new SiteAuthError("not_found");
    if (r.owner !== to) {
      this.log(siteId, actor, "reassign", r.owner, { to, collection, record_id: recordId });
      r.owner = to;
    }
    return { id: recordId, owner_id: to };
  }
  async memberDeleteDataBegin(siteId: string, actor: string, uid: string, confirm: boolean) {
    this.guard(siteId, actor);
    if (confirm !== true) throw new SiteAuthError("confirmation_required");
    if (this.deletions.get(uid) === siteId) return true;
    const i = this.ident(siteId, uid);
    if (!i || i.state === "deleting") throw new SiteAuthError("member_not_found");
    this.notLastAdmin(siteId, uid);
    i.state = "deleting";
    const m = this.member(siteId, uid);
    if (m) m.status = "disabled";
    for (const c of this.changes) if (c.uid === uid && this.open(c)) c.state = "cancelled";
    this.deletions.set(uid, siteId);
    this.bump(siteId, uid);
    this.log(siteId, actor, "delete_data", uid);
    return true;
  }

  async beginEmailChange(siteId: string, uid: string, newEmail: string, newAlias: string, sha256: string, ttl: number) {
    const i = this.idents.find((x) => x.siteId === siteId && x.uid === uid && (x.state === "active" || x.state === "email_change_pending"));
    if (!i || this.sites.get(siteId) !== "active") return "invalid" as const;
    if (i.email === newEmail) return "same" as const;
    if (this.idents.some((x) => x.siteId === siteId && x.email === newEmail)) return "taken" as const;
    for (const c of this.changes) if (c.uid === uid && c.state === "pending") c.state = "cancelled";
    if (this.changes.some((c) => this.open(c) && ((c.siteId === siteId && c.newEmail === newEmail) || c.newAlias === newAlias || c.uid === uid))) {
      return "taken" as const;
    }
    this.changes.push({
      id: `chg-${this.changes.length + 1}`, siteId, uid, oldEmail: i.email, newEmail, newAlias, sha: sha256,
      state: "pending", expiresAt: this.now() + ttl * 1000,
    });
    i.state = "email_change_pending";
    return "reserved" as const;
  }
  async claimEmailChange(siteId: string, sha256: string): Promise<ClaimOutcome> {
    const c = this.changes.find((x) => x.sha === sha256);
    if (!c || c.siteId !== siteId || c.state === "cancelled" || c.state === "failed") return { outcome: "invalid" };
    if (c.state === "done") return { outcome: "used" };
    if (c.state === "expired") return { outcome: "expired" };
    if (c.state === "pending" && c.expiresAt <= this.now()) {
      c.state = "expired";
      const i = this.idents.find((x) => x.uid === c.uid);
      if (i?.state === "email_change_pending") i.state = "active";
      return { outcome: "expired" };
    }
    c.state = "committing";
    return { outcome: "ok", id: c.id, authUserId: c.uid, oldEmail: c.oldEmail, newEmail: c.newEmail, newAlias: c.newAlias };
  }
  async commitEmailChange(id: string) {
    this.calls.push("commitEmailChange");
    const c = this.changes.find((x) => x.id === id && x.state === "committing");
    if (!c) throw new Error("email_change_not_committing");
    if (this.idents.some((x) => x.siteId === c.siteId && x.email === c.newEmail)) throw new Error("duplicate key");
    const i = this.idents.find((x) => x.siteId === c.siteId && x.uid === c.uid)!;
    i.email = c.newEmail; i.alias = c.newAlias; i.state = "active";
    c.state = "done";
    this.bump(c.siteId, c.uid);
    return { oldEmail: c.oldEmail, newEmail: c.newEmail };
  }
  async failEmailChange(id: string) {
    const c = this.changes.find((x) => x.id === id && this.open(x));
    if (!c) return false;
    c.state = "failed";
    const i = this.idents.find((x) => x.uid === c.uid);
    if (i?.state === "email_change_pending") i.state = "active";
    return true;
  }

  async beginDeletion(siteId: string, uid: string) {
    this.calls.push("beginDeletion");
    const i = this.idents.find((x) => x.siteId === siteId && x.uid === uid);
    if (!i) return this.deletions.get(uid) === siteId;
    this.notLastAdmin(siteId, uid);
    if (i.state !== "deleting") this.log(siteId, uid, "self_delete", uid);
    i.state = "deleting";
    const m = this.members.find((x) => x.uid === uid);
    if (m) m.status = "disabled";
    for (const c of this.changes) if (c.uid === uid && this.open(c)) c.state = "cancelled";
    if (!this.deletions.has(uid)) this.deletions.set(uid, siteId);
    this.bump(siteId, uid);
    return true;
  }
  async userObjectNames(siteId: string, uid: string, limit: number) {
    if (this.deletions.get(uid) !== siteId) return [];
    return this.objects.filter((o) => o.name.startsWith(`${siteId}/`) && o.owner === uid).slice(0, limit).map((o) => o.name);
  }
  async deleteAccountData(siteId: string, uid: string) {
    this.calls.push("deleteAccountData");
    if (this.deletions.get(uid) !== siteId) throw new Error("deletion_not_started");
    const before = this.records.length;
    this.records = this.records.filter((r) => !(r.siteId === siteId && r.owner === uid));
    this.idents = this.idents.filter((i) => !(i.siteId === siteId && i.uid === uid));
    this.members = this.members.filter((m) => !(m.siteId === siteId && m.uid === uid));
    this.changes = this.changes.filter((c) => c.uid !== uid);
    return before - this.records.length;
  }
  async finishDeletion(uid: string) {
    this.calls.push("finishDeletion");
    return this.deletions.delete(uid);
  }
  async pendingDeletions(limit: number) {
    return [...this.deletions.entries()].slice(0, limit).map(([authUserId, siteId]) => ({ authUserId, siteId }));
  }
  nonces = new Set<string>();
  async claimNonce(nonce: string, _ttl: number) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
  async rateTake(key: string, win: number, max: number) {
    const k = `${key}@${Math.floor(this.now() / 1000 / win)}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    return n <= max;
  }
}

function b64u(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
export function fakeJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: "shard-key-1" }): string {
  return `${b64u(header)}.${b64u(claims)}.${randomBytes(16).toString("base64url")}`;
}
export function claimsOf(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

interface FUser { id: string; email: string; password: string; confirmed: boolean; otp?: { hash: string; type: string }; mailedAt?: number }

export interface HookMail { type: string; alias: string; tokenHash: string }

export interface GoTrueFaults {
  createUser?: "before" | "after";
  getUserById?: boolean;
  magicLink?: boolean;
  verifyOtp?: boolean;
  deleteUser?: boolean;
  updateUser?: boolean;
}

export class FakeGoTrue implements GoTrue {
  users = new Map<string, FUser>();
  sessions = new Map<string, { uid: string; revoked: boolean; startedAt: number; amr: Array<{ method: string; timestamp: number }> }>();
  refreshTokens = new Map<string, string>();
  hookOutbox: HookMail[] = [];
  removed: string[] = [];
  calls: string[] = [];
  fail: GoTrueFaults = {};
  failUpdateEmail = false;
  mailWindowMs = 0;
  legacyHs256 = false;
  constructor(private store: FakeStore, private now: () => number) {}

  private hook(uid: string, started: number): Record<string, unknown> | null {
    const i = this.store.idents.find((x) => x.uid === uid);
    const m = this.store.members.find((x) => x.uid === uid);
    const u = this.users.get(uid);
    if (!i || !m || !u || m.status !== "active" || this.store.sites.get(i.siteId) !== "active") return null;
    if (!(i.state === "active" || i.state === "email_change_pending")) return null;
    const after = this.store.epochOf(i.siteId, uid);
    if (after !== null && started < after) return null;
    return { site_id: i.siteId, site_role: m.role, session_started_at: started };
  }
  private token(uid: string, sid: string): GoTrueSession | null {
    const s = this.sessions.get(sid)!;
    const extra = this.hook(uid, s.startedAt);
    if (!extra) return null;
    const t = Math.floor(this.now() / 1000);
    const rt = randomBytes(12).toString("hex");
    this.refreshTokens.set(rt, sid);
    const access_token = fakeJwt(
      { sub: uid, role: "authenticated", session_id: sid, amr: s.amr, exp: t + 300, ...extra },
      this.legacyHs256 ? { alg: "HS256", typ: "JWT" } : { alg: "ES256", typ: "JWT", kid: "shard-key-1" },
    );
    return { access_token, refresh_token: rt, expires_at: t + 300, expires_in: 300, token_type: "bearer", user_id: uid };
  }
  private issue(uid: string, method: string): GoTrueSession | null {
    const sid = randomBytes(8).toString("hex");
    const t = Math.floor(this.now() / 1000);
    this.sessions.set(sid, { uid, revoked: false, startedAt: this.store.tick(), amr: [{ method, timestamp: t }] });
    const out = this.token(uid, sid);
    if (!out) this.sessions.delete(sid);
    return out;
  }
  private byEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }
  private throttle(u: FUser) {
    if (this.mailWindowMs > 0 && u.mailedAt !== undefined && this.now() - u.mailedAt < this.mailWindowMs) {
      throw new GoTrueEmailThrottled("For security purposes, you can only request this after 60 seconds.");
    }
  }
  private mint(u: FUser, type: string) {
    this.throttle(u);
    u.mailedAt = this.now();
    const hash = createHash("sha256").update(randomBytes(16)).digest("hex");
    u.otp = { hash, type };
    this.hookOutbox.push({ type, alias: u.email, tokenHash: hash });
  }

  async createUser(a: { id: string; email: string; password: string; emailConfirm: boolean }) {
    this.calls.push("createUser");
    if (this.fail.createUser === "before") throw new Error("gotrue down");
    if (this.users.has(a.id) || this.byEmail(a.email)) throw new Error("already registered");
    this.users.set(a.id, { id: a.id, email: a.email.toLowerCase(), password: a.password, confirmed: a.emailConfirm });
    if (this.fail.createUser === "after") throw new Error("gotrue response lost");
  }
  async getUserById(id: string) {
    if (this.fail.getUserById) throw new Error("gotrue down");
    const u = this.users.get(id);
    return u ? { id, email: u.email, emailConfirmedAt: u.confirmed ? "2026-01-01" : null } : null;
  }
  async updateUserById(id: string, a: { password?: string; email?: string; emailConfirm?: boolean }) {
    this.calls.push(`updateUserById:${Object.keys(a).sort().join(",")}`);
    if (this.fail.updateUser) throw new Error("gotrue down");
    const u = this.users.get(id);
    if (!u) throw new Error("not found");
    if (a.email !== undefined) {
      if (this.failUpdateEmail) throw new Error("gotrue down");
      const other = this.byEmail(a.email);
      if (other && other.id !== id) throw new Error("email exists");
      u.email = a.email.toLowerCase();
    }
    if (a.password !== undefined) u.password = a.password;
    if (a.emailConfirm) u.confirmed = true;
  }
  async deleteUser(id: string) {
    this.calls.push("deleteUser");
    if (this.fail.deleteUser) throw new Error("gotrue down");
    this.users.delete(id);
    for (const s of this.sessions.values()) if (s.uid === id) s.revoked = true;
  }
  async signInWithPassword(email: string, password: string) {
    const u = this.byEmail(email);
    if (!u || u.password !== password || !u.confirmed) return null;
    return this.issue(u.id, "password");
  }
  async magicLinkTokenHash(alias: string) {
    if (this.fail.magicLink) throw new Error("gotrue down");
    const u = this.byEmail(alias);
    if (!u) throw new Error("user not found");
    const hash = createHash("sha256").update(randomBytes(16)).digest("hex");
    u.otp = { hash, type: "magiclink" };
    u.mailedAt = this.now();
    return hash;
  }
  async recoveryTokenHash(alias: string) {
    const u = this.byEmail(alias);
    if (!u) throw new Error("user not found");
    const hash = createHash("sha256").update(randomBytes(16)).digest("hex");
    u.otp = { hash, type: "recovery" };
    u.mailedAt = this.now();
    return hash;
  }
  async verifyOtp(tokenHash: string, type: VerifyType) {
    if (this.fail.verifyOtp) throw new Error("gotrue down");
    const u = [...this.users.values()].find((x) => x.otp?.hash === tokenHash && x.otp.type === type);
    if (!u) return null;
    u.otp = undefined;
    u.confirmed = true;
    return this.issue(u.id, type === "recovery" ? "recovery" : "otp");
  }
  async refresh(rt: string) {
    const sid = this.refreshTokens.get(rt);
    if (!sid) return null;
    this.refreshTokens.delete(rt);
    const s = this.sessions.get(sid);
    if (!s || s.revoked) return null;
    return this.token(s.uid, sid);
  }
  async getUser(token: string) {
    try {
      const c = claimsOf(token);
      const s = this.sessions.get(c.session_id);
      if (!s || s.revoked || s.uid !== c.sub) return null;
      return this.getUserById(c.sub);
    } catch {
      return null;
    }
  }
  async signOut(token: string, scope: "local" | "global" | "others") {
    this.calls.push(`signOut:${scope}`);
    const c = claimsOf(token);
    for (const [sid, s] of this.sessions) {
      if (s.uid !== c.sub) continue;
      if (scope === "global" || (scope === "local" && sid === c.session_id) || (scope === "others" && sid !== c.session_id)) {
        s.revoked = true;
      }
    }
  }
  async sendMagicLink(alias: string) {
    const u = this.byEmail(alias);
    if (!u) throw new Error("Signups not allowed for otp");
    this.mint(u, "magiclink");
  }
  async sendRecovery(alias: string) {
    const u = this.byEmail(alias);
    if (!u) return;
    this.mint(u, "recovery");
  }
  async removeObjects(names: string[]) {
    this.calls.push("removeObjects");
    this.removed.push(...names);
    this.store.objects = this.store.objects.filter((o) => !names.includes(o.name));
  }
}

export class FakeMailer implements SiteMailer {
  sent: MailRequest[] = [];
  async send(_store: ShardStore, req: MailRequest): Promise<"sent" | "limited"> {
    this.sent.push(req);
    return "sent";
  }
}

export const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const ALIAS_KEY = "k".repeat(48);

export function world(opts: { now?: () => number } = {}) {
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const now = opts.now ?? (() => clock);
  const store = new FakeStore(now);
  store.sites.set(SITE_A, "active");
  store.sites.set(SITE_B, "active");
  const gotrue = new FakeGoTrue(store, now);
  const shard: ShardHandle = { shardId: "shard-1", gotrue, store, hookSecret: "v1,whsec_" + Buffer.from("s".repeat(32)).toString("base64") };
  const sites: Record<string, SiteRecord> = {
    [SITE_A]: { siteId: SITE_A, shardId: "shard-1", hostname: "a-shop.zaviagent.com", name: "A Shop", active: true },
    [SITE_B]: { siteId: SITE_B, shardId: "shard-1", hostname: "b-cafe.zaviagent.com", name: "B Cafe", active: true },
  };
  const directory: SiteAuthDirectory = {
    site: async (id) => sites[id] ?? null,
    shard: async (id) => (id === "shard-1" ? shard : null),
  };
  const mailer = new FakeMailer();
  const slept: number[] = [];
  const pending: Promise<unknown>[] = [];
  const deps = {
    directory,
    mailer,
    aliasKey: () => ALIAS_KEY,
    now,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    background: (p: Promise<unknown>) => {
      pending.push(p);
    },
    log: () => {},
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  const ctx = (siteId: string, ip = "203.0.113.7") => ({ siteId, host: sites[siteId]?.hostname ?? "x.zaviagent.com", ip, requestId: "r1" });
  return { store, gotrue, shard, sites, directory, mailer, deps, slept, advance, settle, ctx, now };
}
