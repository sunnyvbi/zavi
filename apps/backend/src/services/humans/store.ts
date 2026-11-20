
import { globalClient } from "@/services/tenant-client";
import {
  creatorSlugBase,
  creatorSlugCandidate,
  type CreatorLane,
} from "@zavi/shared";
import {
  HumanError,
  escapeLikeLiteral,
  mapStoreError,
  normalizeEmail,
  normalizeHandle,
  normalizeLegalName,
  cleanHandle,
  type Discipline,
  type StaffSettableState,
  type VettingState,
} from "./contract";

const MEMBERS = "human_members";
const HANDLES = "human_member_handles";
const PII = "human_member_pii";
const PACKAGES = "creator_packages";

const COLLISION_SCAN_LIMIT = 5000;
const COLLISION_FILTER_MAX_IDS = 500;

export type HumanMemberRow = {
  id: string;
  auth_user_id: string;
  display_name: string;
  discipline: Discipline;
  skills: string[] | null;
  rate_usd: number | null;
  rate_unit: string | null;
  public_metrics: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  vetting_state: VettingState;
  rejected_reason: string | null;
  bio?: string | null;
  handle_verified_at: string | null;
  slug?: string | null;
  lanes?: CreatorLane[] | null;
  city?: string | null;
  country_code?: string | null;
  intro_video_path?: string | null;
  sample_video_paths?: string[] | null;
  created_at: string;
  updated_at: string | null;
};

export type CreatorPackageRow = {
  id: string;
  human_member_id: string;
  kind: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: Array<{ code: string; price_cents: number }> | null;
  active: boolean;
};

export type HumanHandleRow = {
  id?: string;
  human_member_id: string;
  platform: string;
  handle: string;
};

export type HumanPiiRow = {
  human_member_id: string;
  legal_name: string | null;
  email: string | null;
};

export type CollisionField =
  | "handle_cross_platform"
  | "email_normalized"
  | "legal_name"
  | "tin_sha256"
  | "payout_ref_hash";

export type Collision = {
  field: CollisionField;
  value: string;
  collides_with: Array<{ human_member_id: string; display_name: string; vetting_state: VettingState }>;
};

const MEMBER_COLUMNS =
  "id, auth_user_id, display_name, discipline, skills, rate_usd, rate_unit, bio, public_metrics, profile, vetting_state, rejected_reason, handle_verified_at, slug, lanes, city, country_code, intro_video_path, sample_video_paths, created_at, updated_at";

const PACKAGE_COLUMNS =
  "id, human_member_id, kind, title, description, price_cents, currency, delivery_days, video_count, video_length_seconds, ad_rights_days, addons, active";

function sb() {
  return globalClient();
}

function fail(error: { code?: string; message?: string; details?: string } | null): never {
  throw mapStoreError(error);
}

export async function readOwnMember(authUserId: string): Promise<HumanMemberRow | null> {
  const { data, error } = await sb()
    .from(MEMBERS)
    .select(MEMBER_COLUMNS)
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) fail(error);
  return (data as HumanMemberRow | null) ?? null;
}

export async function readHandles(humanMemberId: string): Promise<HumanHandleRow[]> {
  const { data, error } = await sb()
    .from(HANDLES)
    .select("id, human_member_id, platform, handle")
    .eq("human_member_id", humanMemberId);
  if (error) fail(error);
  return (data as HumanHandleRow[] | null) ?? [];
}

export async function readPii(humanMemberId: string): Promise<HumanPiiRow | null> {
  const { data, error } = await sb()
    .from(PII)
    .select("human_member_id, legal_name, email")
    .eq("human_member_id", humanMemberId)
    .maybeSingle();
  if (error) fail(error);
  return (data as HumanPiiRow | null) ?? null;
}

const SLUG_SUFFIX_SCAN = 200;

export async function generateCreatorSlug(displayName: string): Promise<string> {
  const base = creatorSlugBase(displayName);
  const { data, error } = await sb()
    .from(MEMBERS)
    .select("slug")
    .like("slug", `${escapeLikeLiteral(base)}%`)
    .limit(SLUG_SUFFIX_SCAN + 1);
  if (error) fail(error);
  const rows = Array.isArray(data) ? (data as Array<{ slug: string | null }>) : [];
  const taken = new Set(rows.map((r) => r.slug));
  for (let n = 1; n <= SLUG_SUFFIX_SCAN; n++) {
    const candidate = creatorSlugCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return creatorSlugCandidate(base, 1000 + Math.floor(Math.random() * 90000));
}

const SLUG_RACE_RETRIES = 5;

export function randomCreatorSlug(displayName: string): string {
  return creatorSlugCandidate(creatorSlugBase(displayName), 10000 + Math.floor(Math.random() * 90000));
}

type SlugWrite = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

export async function writeWithFreshSlug(displayName: string, write: (slug: string) => PromiseLike<SlugWrite>): Promise<unknown> {
  let slug = await generateCreatorSlug(displayName);
  for (let attempt = 0; attempt <= SLUG_RACE_RETRIES; attempt++) {
    const { data, error } = await write(slug);
    if (!error) return data;
    if (mapStoreError(error).code !== "duplicate_slug") fail(error);
    slug = randomCreatorSlug(displayName);
  }
  throw new HumanError("human_store_error", "Could not save the application. Try again.", 503);
}

export async function readPackages(humanMemberId: string): Promise<CreatorPackageRow[]> {
  const { data, error } = await sb()
    .from(PACKAGES)
    .select(PACKAGE_COLUMNS)
    .eq("human_member_id", humanMemberId)
    .eq("kind", "ugc_video")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) fail(error);
  return (data as CreatorPackageRow[] | null) ?? [];
}

export type HandleRow = { platform: string; handle: string; followers: number | null };

export async function swapMemberHandles(humanMemberId: string, rows: HandleRow[]): Promise<void> {
  const key = (platform: string, handle: string) => `${platform}\u0000${handle.toLowerCase()}`;
  const cur = await sb().from(HANDLES).select("id, platform, handle").eq("human_member_id", humanMemberId);
  if (cur.error) fail(cur.error);
  const existing = new Map(
    ((cur.data as Array<{ id: string; platform: string; handle: string }> | null) ?? []).map((r) => [key(r.platform, r.handle), r]),
  );
  const wanted = new Set(rows.map((r) => key(r.platform, r.handle)));
  const fresh = rows.filter((r) => !existing.has(key(r.platform, r.handle)));
  if (fresh.length > 0) {
    const ins = await sb().from(HANDLES).insert(fresh.map((r) => ({ human_member_id: humanMemberId, ...r })));
    if (ins.error) fail(ins.error);
  }
  for (const r of rows) {
    const kept = existing.get(key(r.platform, r.handle));
    if (!kept) continue;
    const up = await sb()
      .from(HANDLES)
      .update({ handle: r.handle, followers: r.followers })
      .eq("id", kept.id)
      .eq("human_member_id", humanMemberId);
    if (up.error) fail(up.error);
  }
  const stale = [...existing].filter(([k]) => !wanted.has(k)).map(([, r]) => r.id);
  if (stale.length > 0) {
    const del = await sb().from(HANDLES).delete().eq("human_member_id", humanMemberId).in("id", stale);
    if (del.error) fail(del.error);
  }
}

type CollisionIndex = {
  byMember: Map<string, Collision[]>;
  memberIds: string[];
};

function addMatch(
  buckets: Map<string, Map<string, Set<string>>>,
  field: CollisionField,
  key: string,
  memberId: string,
): void {
  if (!key) return;
  let byKey = buckets.get(field);
  if (!byKey) {
    byKey = new Map();
    buckets.set(field, byKey);
  }
  const set = byKey.get(key) ?? new Set<string>();
  set.add(memberId);
  byKey.set(key, set);
}

export async function buildCollisionIndex(): Promise<CollisionIndex> {
  const [handlesRes, piiRes, membersRes] = await Promise.all([
    sb().from(HANDLES).select("human_member_id, platform, handle").limit(COLLISION_SCAN_LIMIT),
    sb()
      .from(PII)
      .select("human_member_id, legal_name, email, tin_sha256, payout_ref_hash")
      .limit(COLLISION_SCAN_LIMIT),
    sb().from(MEMBERS).select("id, display_name, vetting_state").limit(COLLISION_SCAN_LIMIT),
  ]);
  if (handlesRes.error) fail(handlesRes.error);
  if (piiRes.error) fail(piiRes.error);
  if (membersRes.error) fail(membersRes.error);

  const labels = new Map<string, { human_member_id: string; display_name: string; vetting_state: VettingState }>();
  for (const m of (membersRes.data as Array<{ id: string; display_name: string; vetting_state: VettingState }> | null) ?? []) {
    labels.set(m.id, { human_member_id: m.id, display_name: m.display_name, vetting_state: m.vetting_state });
  }

  const buckets = new Map<string, Map<string, Set<string>>>();
  const displayValue = new Map<string, string>();

  for (const h of (handlesRes.data as Array<{ human_member_id: string; platform: string; handle: string }> | null) ?? []) {
    const key = normalizeHandle(h.handle ?? "");
    addMatch(buckets, "handle_cross_platform", key, h.human_member_id);
    displayValue.set(`handle_cross_platform:${key}`, `@${cleanHandle(h.handle ?? "")}`);
  }
  for (const p of (piiRes.data as Array<{
    human_member_id: string;
    legal_name: string | null;
    email: string | null;
    tin_sha256: string | null;
    payout_ref_hash: string | null;
  }> | null) ?? []) {
    if (p.email) {
      const key = normalizeEmail(p.email);
      addMatch(buckets, "email_normalized", key, p.human_member_id);
      displayValue.set(`email_normalized:${key}`, key);
    }
    if (p.legal_name) {
      const key = normalizeLegalName(p.legal_name);
      addMatch(buckets, "legal_name", key, p.human_member_id);
      displayValue.set(`legal_name:${key}`, p.legal_name);
    }
    if (p.tin_sha256) addMatch(buckets, "tin_sha256", String(p.tin_sha256), p.human_member_id);
    if (p.payout_ref_hash) addMatch(buckets, "payout_ref_hash", String(p.payout_ref_hash), p.human_member_id);
  }

  const byMember = new Map<string, Collision[]>();
  for (const [field, byKey] of buckets) {
    for (const [key, members] of byKey) {
      if (members.size < 2) continue;
      for (const memberId of members) {
        const others = [...members]
          .filter((id) => id !== memberId)
          .map((id) => labels.get(id) ?? { human_member_id: id, display_name: "(unknown)", vetting_state: "pending" as VettingState });
        const list = byMember.get(memberId) ?? [];
        list.push({
          field: field as CollisionField,
          value:
            field === "tin_sha256" || field === "payout_ref_hash"
              ? "(redacted)"
              : displayValue.get(`${field}:${key}`) ?? key,
          collides_with: others,
        });
        byMember.set(memberId, list);
      }
    }
  }
  return { byMember, memberIds: [...byMember.keys()] };
}

export type HumanQueueFilter = {
  vetting_state?: VettingState;
  discipline?: Discipline;
  has_collision?: boolean;
  limit: number;
  offset: number;
  sort: "oldest" | "newest";
};

export type HumanQueuePage = {
  items: Array<HumanMemberRow & { collision_count: number }>;
  total: number;
  limit: number;
  offset: number;
};

export async function listMembers(filter: HumanQueueFilter): Promise<HumanQueuePage> {
  const index = await buildCollisionIndex();

  let query = sb().from(MEMBERS).select(MEMBER_COLUMNS, { count: "exact" });
  if (filter.vetting_state) query = query.eq("vetting_state", filter.vetting_state);
  if (filter.discipline) query = query.eq("discipline", filter.discipline);

  if (filter.has_collision === true) {
    if (index.memberIds.length === 0) {
      return { items: [], total: 0, limit: filter.limit, offset: filter.offset };
    }
    if (index.memberIds.length > COLLISION_FILTER_MAX_IDS) {
      throw new HumanError(
        "human_store_error",
        "Too many colliding applicants to filter in one page. Narrow by discipline or state.",
        503,
      );
    }
    query = query.in("id", index.memberIds);
  } else if (filter.has_collision === false && index.memberIds.length > 0) {
    if (index.memberIds.length > COLLISION_FILTER_MAX_IDS) {
      throw new HumanError(
        "human_store_error",
        "Too many colliding applicants to filter in one page. Narrow by discipline or state.",
        503,
      );
    }
    query = query.not("id", "in", `(${index.memberIds.join(",")})`);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: filter.sort !== "newest" })
    .range(filter.offset, filter.offset + filter.limit - 1);
  if (error) fail(error);

  const items = ((data as HumanMemberRow[] | null) ?? []).map((row) => ({
    ...row,
    collision_count: index.byMember.get(row.id)?.length ?? 0,
  }));
  return { items, total: typeof count === "number" ? count : items.length, limit: filter.limit, offset: filter.offset };
}

export type HumanMemberDetail = {
  member: HumanMemberRow;
  handles: HumanHandleRow[];
  pii: HumanPiiRow | null;
  collisions: Collision[];
};

export async function getMemberDetail(id: string): Promise<HumanMemberDetail> {
  const { data, error } = await sb().from(MEMBERS).select(MEMBER_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail(error);
  const member = data as HumanMemberRow | null;
  if (!member) throw new HumanError("not_found", "No human applicant with that id.", 404);

  const [handles, pii, index] = await Promise.all([readHandles(id), readPii(id), buildCollisionIndex()]);
  return { member, handles, pii, collisions: index.byMember.get(id) ?? [] };
}

export async function setVettingState(
  id: string,
  state: StaffSettableState,
  reason: string | null,
): Promise<HumanMemberRow> {
  if (state === "rejected" && !reason?.trim()) {
    throw new HumanError("reason_required", "A rejection must carry a reason.", 400);
  }
  const patch: Record<string, unknown> = {
    vetting_state: state,
    rejected_reason: state === "rejected" ? reason!.trim() : null,
    updated_at: new Date().toISOString(),
  };
  if (state === "approved") patch.handle_verified_at = new Date().toISOString();

  const { data, error } = await sb().from(MEMBERS).update(patch).eq("id", id).select(MEMBER_COLUMNS).maybeSingle();
  if (error) fail(error);
  const row = data as HumanMemberRow | null;
  if (!row) throw new HumanError("not_found", "No human applicant with that id.", 404);
  return row;
}
