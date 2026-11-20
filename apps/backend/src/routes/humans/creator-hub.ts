
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { computeCreatorFees } from "@/services/creators/order-fees";
import { creatorPayoutCountrySupported } from "@/services/creators/payout-countries";
import { loadCreatorReputation } from "@/services/humans/creatorReviews";
import { realIntroVideoDeps, streamIntroVideo, type IntroVideoDeps } from "@/services/creators/intro-video";
import { signCreatorMedia } from "@/services/creators/creator-media";

const MemberParam = z.object({ memberId: z.string().uuid() });

export const SELF_REPORTED_LABEL = "Self-reported, not checked by Zavi";

export type CreatorCardSocial = {
  platform: string;
  handle: string;
  url: string | null;
  followers: number | null;
  label: string;
};

export type CreatorCardPackage = {
  id: string;
  kind: "ugc_video";
  title: string;
  price_cents: number;
  business_total_cents: number;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
};

export type CreatorCard = {
  human_member_id: string;
  slug: string | null;
  display_name: string;
  city: string | null;
  country_code: string | null;
  bio: string | null;
  lanes: string[];
  niches: string[];
  has_intro_video: boolean;
  photo_url: string | null;
  illustration_url: string | null;
  bookable: boolean;
  socials: CreatorCardSocial[];
  packages: CreatorCardPackage[];
  rating: { average: number | null; count: number };
};

export function socialUrl(platform: string, handle: string): string | null {
  const h = handle.trim().replace(/^@+/, "");
  if (!h || /[\s/?#:]/.test(h)) return null;
  switch (platform) {
    case "tiktok":
      return `https://www.tiktok.com/@${h}`;
    case "instagram":
      return `https://www.instagram.com/${h}`;
    case "youtube":
      return `https://www.youtube.com/@${h}`;
    case "x":
      return `https://x.com/${h}`;
    case "linkedin":
      return `https://www.linkedin.com/in/${h}`;
    default:
      return null;
  }
}

type MemberRow = {
  id: string;
  slug: string | null;
  display_name: string | null;
  city: string | null;
  country_code: string | null;
  bio: string | null;
  lanes: string[] | null;
  skills: string[] | null;
  intro_video_path: string | null;
  auth_user_id?: string | null;
  photo_path?: string | null;
  illustration_path?: string | null;
  vetting_state: string;
};

type PackageRow = Omit<CreatorCardPackage, "business_total_cents">;

export type CreatorCardDeps = {
  loadMember: (id: string) => Promise<MemberRow | null>;
  loadHandles: (id: string) => Promise<Array<{ platform: string; handle: string; followers?: number | null }>>;
  loadPackages: (id: string) => Promise<PackageRow[]>;
  loadRating: (id: string) => Promise<{ average: number | null; count: number }>;
  signMedia?: (path: string, ownerAuthUserId: string | null | undefined) => Promise<string | null>;
};

function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || /column .* does not exist/i.test(error.message ?? "");
}

export const realCreatorCardDeps: CreatorCardDeps = {
  async loadMember(id) {
    const base = "id,slug,display_name,city,country_code,bio,lanes,skills,intro_video_path,vetting_state";
    const read = (cols: string) => globalClient().from("human_members").select(cols).eq("id", id).maybeSingle();
    let { data, error } = await read(`${base},auth_user_id,photo_path,illustration_path`);
    if (error && isMissingColumn(error)) ({ data, error } = await read(base));
    if (error) throw new Error(`human_members read failed: ${error.message}`);
    return (data as unknown as MemberRow | null) ?? null;
  },
  async loadHandles(id) {
    const read = (cols: string) =>
      globalClient()
        .from("human_member_handles")
        .select(cols)
        .eq("human_member_id", id)
        .order("created_at", { ascending: true })
        .limit(20);
    let { data, error } = await read("platform,handle,followers");
    if (error && isMissingColumn(error)) ({ data, error } = await read("platform,handle"));
    if (error) throw new Error(`human_member_handles read failed: ${error.message}`);
    return (data ?? []) as unknown as Array<{ platform: string; handle: string; followers?: number | null }>;
  },
  async loadPackages(id) {
    const { data, error } = await globalClient()
      .from("creator_packages")
      .select("id,kind,title,price_cents,delivery_days,video_count,video_length_seconds,ad_rights_days")
      .eq("human_member_id", id)
      .eq("kind", "ugc_video")
      .eq("active", true)
      .order("price_cents", { ascending: true })
      .limit(20);
    if (error) throw new Error(`creator_packages read failed: ${error.message}`);
    return (data ?? []) as unknown as PackageRow[];
  },
  async loadRating(id) {
    const rep = await loadCreatorReputation(id);
    return { average: rep.aggregates.avg_overall, count: rep.aggregates.review_count };
  },
};

export async function buildCreatorCard(
  memberId: string,
  deps: CreatorCardDeps = realCreatorCardDeps,
): Promise<CreatorCard | null> {
  const m = await deps.loadMember(memberId);
  if (!m || m.vetting_state !== "approved") return null;
  const sign = deps.signMedia ?? signCreatorMedia;
  const [handles, packages, rating, photo_url, illustration_url] = await Promise.all([
    deps.loadHandles(memberId),
    deps.loadPackages(memberId),
    deps.loadRating(memberId).catch(() => ({ average: null, count: 0 })),
    m.photo_path ? sign(m.photo_path, m.auth_user_id).catch(() => null) : Promise.resolve(null),
    !m.photo_path && m.illustration_path ? sign(m.illustration_path, m.auth_user_id).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    human_member_id: m.id,
    slug: m.slug,
    display_name: m.display_name ?? "",
    city: m.city,
    country_code: m.country_code,
    bio: m.bio,
    lanes: m.lanes ?? [],
    niches: m.skills ?? [],
    has_intro_video: Boolean(m.intro_video_path),
    photo_url,
    illustration_url,
    bookable: creatorPayoutCountrySupported(m.country_code),
    socials: handles.map((h) => ({
      platform: h.platform,
      handle: h.handle.replace(/^@+/, ""),
      url: socialUrl(h.platform, h.handle),
      followers: typeof h.followers === "number" && Number.isFinite(h.followers) ? h.followers : null,
      label: SELF_REPORTED_LABEL,
    })),
    packages: packages
      .filter((p) => Number.isInteger(p.price_cents) && p.price_cents > 0)
      .map((p) => ({ ...p, business_total_cents: computeCreatorFees(p.price_cents).business_total_cents })),
    rating: {
      average: rating.count > 0 && rating.average !== null ? Math.round(rating.average * 10) / 10 : null,
      count: rating.count,
    },
  };
}

export async function getCreatorCard(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = MemberParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
    return;
  }
  try {
    const card = await buildCreatorCard(parsed.data.memberId);
    if (!card) {
      res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
      return;
    }
    res.json({ creator: card });
  } catch {
    res.status(503).json({ error: { code: "creator_card_failed", message: "Could not load this creator just now." } });
  }
}

export async function serveCreatorIntroVideo(
  req: Request,
  res: Response,
  deps: Pick<CreatorCardDeps, "loadMember"> = realCreatorCardDeps,
  video: IntroVideoDeps = realIntroVideoDeps,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = MemberParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
    return;
  }
  let m: MemberRow | null;
  try {
    m = await deps.loadMember(parsed.data.memberId);
  } catch {
    res.status(503).json({ error: { code: "intro_video_unavailable", message: "The video did not load. Try again." } });
    return;
  }
  if (!m || m.vetting_state !== "approved") {
    res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });
    return;
  }
  await streamIntroVideo(res, m.intro_video_path, m.auth_user_id, video);
}

export async function getCreatorIntroVideo(req: Request, res: Response): Promise<void> {
  await serveCreatorIntroVideo(req, res);
}

export type BusinessThreadSummary = {
  thread_id: string;
  human_member_id: string;
  display_name: string;
  last_message: { body: string; sender_kind: string; created_at: string } | null;
  last_message_at: string | null;
  unread_count: number;
};

const UNREAD_WINDOW = 100;

export async function listBusinessCreatorThreads(tenant_id: string): Promise<BusinessThreadSummary[]> {
  const client = tenantClient(asTenantId(tenant_id));
  const { data: threads, error } = await client
    .from("creator_threads")
    .select("id, human_member_id, last_message_at, created_at")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw new Error(`creator_threads read failed: ${error.message}`);
  const rows = (threads ?? []) as Array<{
    id: string;
    human_member_id: string;
    last_message_at: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return [];

  const memberIds = Array.from(new Set(rows.map((r) => r.human_member_id)));
  const perThread = Promise.all(
    rows.map((r) =>
      client
        .from("creator_thread_messages")
        .select("thread_id, body, sender_kind, created_at")
        .eq("thread_id", r.id)
        .order("created_at", { ascending: false })
        .limit(UNREAD_WINDOW),
    ),
  ).then((rs) => {
    const bad = rs.find((r) => r.error);
    return { data: bad ? null : rs.flatMap((r) => (r.data ?? []) as unknown[]), error: bad?.error ?? null };
  });
  const [{ data: members, error: membersError }, { data: messages, error: messagesError }] = await Promise.all([
    globalClient().from("human_members").select("id, display_name").in("id", memberIds),
    perThread,
  ]);
  if (membersError) throw new Error(`human_members read failed: ${membersError.message}`);
  if (messagesError) throw new Error(`creator_thread_messages read failed: ${messagesError.message}`);
  const names = new Map(
    ((members ?? []) as Array<{ id: string; display_name: string | null }>).map((m) => [m.id, m.display_name ?? ""]),
  );
  const last = new Map<string, { body: string; sender_kind: string; created_at: string }>();
  const unread = new Map<string, number>();
  const replied = new Set<string>();
  for (const m of (messages ?? []) as Array<{ thread_id: string; body: string; sender_kind: string; created_at: string }>) {
    if (!last.has(m.thread_id)) last.set(m.thread_id, { body: m.body, sender_kind: m.sender_kind, created_at: m.created_at });
    if (replied.has(m.thread_id)) continue;
    if (m.sender_kind === "tenant") replied.add(m.thread_id);
    else if (m.sender_kind === "creator") unread.set(m.thread_id, (unread.get(m.thread_id) ?? 0) + 1);
  }
  return rows.map((r) => ({
    thread_id: r.id,
    human_member_id: r.human_member_id,
    display_name: names.get(r.human_member_id) ?? "",
    last_message: last.get(r.id) ?? null,
    last_message_at: r.last_message_at ?? r.created_at,
    unread_count: unread.get(r.id) ?? 0,
  }));
}

export async function getBusinessCreatorThreads(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({ threads: await listBusinessCreatorThreads(auth.tenant_id) });
  } catch {
    res.status(503).json({ error: { code: "creator_threads_failed", message: "Could not load your messages just now." } });
  }
}
