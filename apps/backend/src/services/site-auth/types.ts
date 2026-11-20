
export interface SiteSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  email?: string;
}

export interface GoTrueSession extends SiteSession {
  user_id: string;
}

export interface GoTrueUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
}

export type VerifyType = "signup" | "magiclink" | "recovery" | "invite" | "email";

export interface GoTrue {
  createUser(a: { id: string; email: string; password: string; emailConfirm: boolean }): Promise<void>;
  getUserById(id: string): Promise<GoTrueUser | null>;
  updateUserById(id: string, a: { password?: string; email?: string; emailConfirm?: boolean }): Promise<void>;
  deleteUser(id: string): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<GoTrueSession | null>;
  magicLinkTokenHash(aliasEmail: string): Promise<string>;
  recoveryTokenHash(aliasEmail: string): Promise<string>;
  verifyOtp(tokenHash: string, type: VerifyType): Promise<GoTrueSession | null>;
  refresh(refreshToken: string): Promise<GoTrueSession | null>;
  getUser(accessToken: string): Promise<GoTrueUser | null>;
  signOut(accessToken: string, scope: "local" | "global" | "others"): Promise<void>;
  sendMagicLink(aliasEmail: string): Promise<void>;
  sendRecovery(aliasEmail: string): Promise<void>;
  removeObjects(names: string[]): Promise<void>;
}

export interface IdentityRow {
  siteId: string;
  emailNorm: string;
  alias: string;
  state: "pending" | "unverified" | "active" | "email_change_pending" | "deleting";
  role: string | null;
  memberStatus: string | null;
  sessionsValidAfter: number | null;
}

export type ClaimOutcome =
  | {
      outcome: "ok";
      id: string;
      authUserId: string;
      oldEmail: string;
      newEmail: string;
      newAlias: string;
    }
  | { outcome: "invalid" | "used" | "expired" };

export type ConfirmBegin =
  | { outcome: "ok"; authUserId: string; email: string; alias: string }
  | { outcome: "done"; authUserId: string; alias: string }
  | { outcome: "busy" | "expired" | "invalid" };

export interface OutboxRow {
  id: string;
  siteId: string;
  to: string;
  kind: "verify_signup" | "account_exists";
  challengeId: string | null;
}

export type FormNoticeLease = Pick<FormNoticeRow, "id" | "leaseToken">;

export interface FormNoticeRow {
  id: string;
  leaseToken: string;
  siteId: string;
  collection: string;
  recordId: string;
  data: Record<string, unknown>;
  fields: Record<string, unknown>;
  createdAt: string;
}

export interface MemberRow {
  user_id: string;
  email: string;
  role: string;
  status: "active" | "disabled" | "invited";
  created_at: string;
}

export interface AliasResolution {
  siteId: string;
  authUserId: string;
  emailNorm: string;
  kind: "current" | "pending_change";
  state: string;
}

export interface SubmissionWindow {
  since: Date;
  until: Date;
  prevSince: Date;
  tz: string;
}

export interface SubmissionStatRow {
  collection: string;
  viaAction: boolean;
  day: string | null;
  n: number | null;
  prevN: number | null;
  totalN: number | null;
  lastAt: string | null;
}

export interface ShardStore {
  identityByUser(uid: string): Promise<IdentityRow | null>;
  identityByEmail(siteId: string, email: string): Promise<(IdentityRow & { authUserId: string }) | null>;
  resolveAlias(alias: string): Promise<AliasResolution[]>;

  signupRequest(a: {
    siteId: string; email: string; alias: string; uid: string; challengeId: string; tokenSha256: string;
    ttlSeconds: number; cooldownSeconds: number; maxLive: number;
  }): Promise<void>;
  signupConfirmBegin(siteId: string, tokenSha256: string, leaseSeconds: number): Promise<ConfirmBegin>;
  signupConfirmRelease(siteId: string, tokenSha256: string): Promise<boolean>;
  signupQuarantine(siteId: string, tokenSha256: string): Promise<boolean>;
  signupConfirmFinish(siteId: string, tokenSha256: string): Promise<"ok" | "done" | "conflict" | "invalid">;
  signupPurge(limit: number): Promise<Array<{ siteId: string; authUserId: string; alias: string }>>;
  outboxClaim(limit: number, leaseSeconds: number): Promise<OutboxRow[]>;
  outboxDone(id: string): Promise<boolean>;
  outboxDefer(id: string, seconds: number): Promise<boolean>;

  formNotifyClaim(limit: number, leaseSeconds: number): Promise<FormNoticeRow[]>;
  formNotifyPurge(limit: number): Promise<Array<{ reason: string; n: number }>>;
  formNotifyBacklog(): Promise<{ pending: number; oldestAgeS: number }>;
  formNotifyDone(leases: FormNoticeLease[]): Promise<number>;
  formNotifyDefer(leases: FormNoticeLease[], seconds: number): Promise<number>;

  submissionStats(siteId: string, window: SubmissionWindow): Promise<SubmissionStatRow[]>;

  provisionIdentity(siteId: string, email: string, alias: string, uid: string): Promise<
    | { outcome: "created" | "exists"; authUserId: string; state: IdentityRow["state"] }
    | { outcome: "reserved" }
    | { outcome: "site_unavailable" }
  >;
  bootstrapAdmin(siteId: string, uid: string): Promise<boolean>;
  revokeSessions(siteId: string, uid: string): Promise<boolean>;
  memberInviteReserve(
    siteId: string, actor: string, email: string, alias: string, uid: string, role: string,
  ): Promise<{ outcome: "create" | "exists" | "held"; authUserId: string | null }>;
  memberInviteFinish(siteId: string, actor: string, uid: string): Promise<boolean>;
  memberList(siteId: string, actor: string, cursor: string | null, limit: number): Promise<MemberRow[]>;
  memberSetRole(siteId: string, actor: string, uid: string, role: string): Promise<MemberRow>;
  memberDisable(siteId: string, actor: string, uid: string): Promise<MemberRow>;
  memberRemoveBegin(siteId: string, actor: string, uid: string): Promise<boolean>;
  memberEnable(siteId: string, actor: string, uid: string): Promise<MemberRow>;
  memberReassignRecord(siteId: string, actor: string, collection: string, recordId: string, to: string): Promise<{ id: string; owner_id: string }>;
  memberDeleteDataBegin(siteId: string, actor: string, uid: string, confirm: boolean): Promise<boolean>;

  beginEmailChange(
    siteId: string,
    uid: string,
    newEmail: string,
    newAlias: string,
    tokenSha256: string,
    ttlSeconds: number,
  ): Promise<"reserved" | "taken" | "same" | "invalid">;
  claimEmailChange(siteId: string, tokenSha256: string): Promise<ClaimOutcome>;
  commitEmailChange(id: string): Promise<{ oldEmail: string; newEmail: string }>;
  failEmailChange(id: string): Promise<boolean>;
  beginDeletion(siteId: string, uid: string): Promise<boolean>;
  userObjectNames(siteId: string, uid: string, limit: number): Promise<string[]>;
  deleteAccountData(siteId: string, uid: string): Promise<number>;
  finishDeletion(uid: string): Promise<boolean>;
  pendingDeletions(limit: number): Promise<Array<{ authUserId: string; siteId: string }>>;
  rateTake(key: string, windowSeconds: number, max: number): Promise<boolean>;
  claimNonce(nonce: string, ttlSeconds: number): Promise<boolean>;
}

export interface SiteRecord {
  siteId: string;
  shardId: string;
  hostname: string;
  name: string;
  active: boolean;
  test?: boolean;
}

export interface ShardHandle {
  shardId: string;
  gotrue: GoTrue;
  store: ShardStore;
  hookSecret: string;
}

export interface SiteAuthDirectory {
  site(siteId: string): Promise<SiteRecord | null>;
  shard(shardId: string): Promise<ShardHandle | null>;
}

export type MailKind =
  | "verify_signup"
  | "magic_link"
  | "recovery"
  | "invite"
  | "email_otp"
  | "email_change_confirm"
  | "email_changed_notice"
  | "account_exists";

export interface MailRequest {
  site: SiteRecord;
  to: string;
  kind: MailKind;
  link?: string;
  detail?: string;
}

export interface SiteMailer {
  send(store: ShardStore, req: MailRequest): Promise<"sent" | "limited" | "suppressed">;
}

export interface SiteRequestContext {
  siteId: string;
  shardId?: string;
  host: string;
  ip: string;
  requestId: string;
}
