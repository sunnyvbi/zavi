import { randomUUID } from "node:crypto";
import { SOCIAL_LIMITS, xWeightedLength } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc, tenantStorage, type TenantClient } from "@/services/tenant-client";
import { VIDEO_PATH_RE, validateChannelPayload } from "@/services/connectors/social-channels";
import { resolveSocialPublishAccount } from "@/services/connectors/social-publish-account";
import { localOverrideAllows } from "@/services/connectors/social-publish-gate";
import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";
import { refuseIfSocialPostPlanLocked } from "@/routes/approvals/decision-channel";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { isTenantArtifactPath } from "@/routes/run-artifacts/file-url";
import { inngest } from "@/../workers/client";

export const SOCIAL_PUBLISH_CLASS = "social.publish.v2";
export const LIBRARY_POST_ORIGIN = "library_post";
const MEDIA_BUCKET = "launch-video-media";
const SOURCE_BUCKETS = new Set(["agent-artifacts", "launch-video-artifacts"]);
const MAX_BYTES = 50 * 1024 * 1024;

export const POST_TARGETS = [
  { name: "instagram", label: "Instagram", channel: "instagram_video" },
  { name: "facebook", label: "Facebook", channel: null },
  { name: "linkedin", label: "LinkedIn", channel: "linkedin_video" },
  { name: "x", label: "X", channel: "x_video" },
  { name: "tiktok", label: "TikTok", channel: "tiktok_video" },
  { name: "youtube", label: "YouTube", channel: "youtube_video" },
] as const;

export type PostTargetName = (typeof POST_TARGETS)[number]["name"];
export type PostTargetStatus = "connected" | "not_connected" | "coming_soon";
export type PostTarget = { name: PostTargetName; label: string; status: PostTargetStatus };
export type PostOutcome =
  | { name: PostTargetName; status: "posted" | "already_posted" }
  | { name: PostTargetName; status: "not_connected" | "coming_soon" | "failed"; message: string };

export const POST_TARGET_NAMES = POST_TARGETS.map((t) => t.name) as PostTargetName[];
const IN_FLIGHT = new Set(["proposed", "approved", "dispatching"]);
const POST_DEAD = new Set(["failed", "cancelled"]);
const UNCONFIRMED = "transient_exhausted";
const FOUNDER_SAFE_DETAIL = new Set(["invalid_edit"]);
const TRY_AGAIN = "This post did not go out. Try again in a minute.";

export class PostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Db = TenantClient;
type Storage = {
  from: (bucket: string) => {
    download: (path: string) => PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
    upload: (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => PromiseLike<{ error: { message: string } | null }>;
  };
};

export type PostDeps = {
  db: (tenant_id: string) => Db;
  storage: (tenant_id: string) => Storage;
  emit: (tenant_id: string, body: Record<string, unknown>) => Promise<string>;
  decide: typeof decideOnDecision;
  gateOpen: (tenant_id: string) => Promise<boolean>;
  planLocked: (tenant_id: string, channel: string) => Promise<string | null>;
  connected: (tenant_id: string, channel: string) => Promise<boolean>;
  redispatch: (tenant_id: string, decision_id: string) => Promise<void>;
};

export const defaultPostDeps: PostDeps = {
  db: (tenant_id) => tenantClient(asTenantId(tenant_id)),
  storage: (tenant_id) => tenantStorage(asTenantId(tenant_id)) as unknown as Storage,
  async emit(tenant_id, body) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "emit_decision", {
      p_agent_run_id: null,
      p_decision_class: SOCIAL_PUBLISH_CLASS,
      p_body: body,
    });
    if (error || !data) throw new Error(`emit_decision failed: ${error?.message ?? "no id"}`);
    return String(data);
  },
  decide: decideOnDecision,
  async gateOpen(tenant_id) {
    return (await isSocialPublishEnabled()) || localOverrideAllows(tenant_id);
  },
  async planLocked(tenant_id, channel) {
    const refusal = await refuseIfSocialPostPlanLocked(tenant_id, channel);
    return refusal ? refusal.message : null;
  },
  async connected(tenant_id, channel) {
    try {
      await resolveSocialPublishAccount(tenant_id, channel);
      return true;
    } catch {
      return false;
    }
  },
  async redispatch(tenant_id, decision_id) {
    await inngest.send({
      id: `approve:${decision_id}:redispatch:${randomUUID()}`,
      name: "decision.approved",
      data: { decision_id, tenant_id, decision_class: SOCIAL_PUBLISH_CLASS },
    });
  },
};

type DecisionRow = { id: string; status: string | null; emitted_at: string | null; autonomy_at_emit?: string | null; body: Record<string, unknown> | null };
type PostRow = { decision_id: string; status: string; last_error?: string | null };

function videoTitle(filename: string | null, storage_path: string): string {
  const base = (filename ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim();
  const tag = /(?:^|\/)(?:edited-)?ai-ugc-video-([0-9a-f]{8})-[0-9a-f]{8}\.mp4$/i.exec(storage_path)?.[1];
  const title = tag && base.toLowerCase().endsWith(` ${tag.toLowerCase()}`) ? base.slice(0, -tag.length).trim() : base;
  return title || "New video";
}

function cutText(value: string, max: number): string {
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function payloadFor(channel: string, caption: string, title: string, video_path: string): Record<string, unknown> {
  const limit = (SOCIAL_LIMITS as Record<string, { text: number; title?: number }>)[channel];
  const xCut = channel === "x" || channel === "x_image" || channel === "x_video" ? xWeightedLength(caption, limit.text).cutAt : null;
  const text = cutText(caption, Math.min(limit.text, xCut ?? limit.text));
  if (channel === "youtube_video") return { title: cutText(title, limit.title ?? 100), text, video_path, privacy: "public" };
  return { text, video_path };
}

async function readVideoDecisions(db: Db, artifact_ids: string[]): Promise<{ decisions: DecisionRow[]; posts: PostRow[] }> {
  if (artifact_ids.length === 0) return { decisions: [], posts: [] };
  const { data, error } = await db
    .from("decisions")
    .select("id, status, emitted_at, autonomy_at_emit, body")
    .eq("decision_class", SOCIAL_PUBLISH_CLASS)
    .eq("body->>origin", LIBRARY_POST_ORIGIN)
    .in("body->>source_video_id", artifact_ids);
  if (error) throw new Error(`library post read failed: ${error.message}`);
  const decisions = (data ?? []) as DecisionRow[];
  if (decisions.length === 0) return { decisions, posts: [] };
  const posts = await db
    .from("social_posts")
    .select("decision_id, status, last_error")
    .in("decision_id", decisions.map((d) => d.id));
  if (posts.error) throw new Error(`library post status read failed: ${posts.error.message}`);
  return { decisions, posts: (posts.data ?? []) as PostRow[] };
}

function isUnconfirmedPost(p: PostRow): boolean {
  return p.status === "failed" && p.last_error === UNCONFIRMED;
}

function isLive(d: DecisionRow, posts: PostRow[], repost = false): boolean {
  const mine = posts.filter((p) => p.decision_id === d.id);
  if (mine.length > 0) return mine.some((p) => !POST_DEAD.has(p.status) || (!repost && isUnconfirmedPost(p)));
  return IN_FLIGHT.has(d.status ?? "");
}

function isUnconfirmed(d: DecisionRow, posts: PostRow[]): boolean {
  const mine = posts.filter((p) => p.decision_id === d.id);
  return mine.some(isUnconfirmedPost) && mine.every((p) => POST_DEAD.has(p.status));
}

function isFailed(d: DecisionRow, posts: PostRow[]): boolean {
  const mine = posts.filter((p) => p.decision_id === d.id);
  if (mine.length === 0) return d.status === "dispatch_failed";
  return mine.every((p) => p.status === "failed" && !isUnconfirmedPost(p));
}

function isPublished(d: DecisionRow, posts: PostRow[]): boolean {
  return posts.some((p) => p.decision_id === d.id && p.status === "published");
}

export type PostState = { posted_on: PostTargetName[]; posting_on: PostTargetName[]; check_on: PostTargetName[]; failed_on: PostTargetName[] };
export type PostStates = Record<string, PostState>;

function oldestFirst(a: DecisionRow, b: DecisionRow): number {
  return (a.emitted_at ?? "").localeCompare(b.emitted_at ?? "") || a.id.localeCompare(b.id);
}

function nameFor(channel: unknown): PostTargetName | null {
  return POST_TARGETS.find((t) => t.channel === channel)?.name ?? null;
}

const byTargetOrder = (a: PostTargetName, b: PostTargetName) => POST_TARGET_NAMES.indexOf(a) - POST_TARGET_NAMES.indexOf(b);

export async function readPostStates(
  tenant_id: string,
  artifact_ids: string[],
  deps: Pick<PostDeps, "db"> = defaultPostDeps,
): Promise<PostStates> {
  const { decisions, posts } = await readVideoDecisions(deps.db(tenant_id), artifact_ids);
  const out: PostStates = {};
  const newest = new Map<string, DecisionRow>();
  for (const d of [...decisions].sort(oldestFirst)) {
    const video = typeof d.body?.source_video_id === "string" ? d.body.source_video_id : null;
    const name = nameFor(d.body?.channel);
    if (!video || !name || d.status === "proposed") continue;
    if (d.status === "dispatch_failed" || posts.some((p) => p.decision_id === d.id)) newest.set(`${video}|${name}`, d);
    if (!isLive(d, posts)) continue;
    const entry = (out[video] ??= { posted_on: [], posting_on: [], check_on: [], failed_on: [] });
    const list = isPublished(d, posts) ? entry.posted_on : isUnconfirmed(d, posts) ? entry.check_on : entry.posting_on;
    if (!list.includes(name)) list.push(name);
  }
  for (const [key, d] of newest) {
    if (!isFailed(d, posts)) continue;
    const [video, name] = key.split("|") as [string, PostTargetName];
    const entry = (out[video] ??= { posted_on: [], posting_on: [], check_on: [], failed_on: [] });
    entry.failed_on.push(name);
  }
  for (const entry of Object.values(out)) {
    const taken = (n: PostTargetName, ...lists: PostTargetName[][]) => lists.some((l) => l.includes(n));
    entry.posting_on = entry.posting_on.filter((n) => !taken(n, entry.posted_on));
    entry.check_on = entry.check_on.filter((n) => !taken(n, entry.posted_on, entry.posting_on));
    entry.failed_on = entry.failed_on.filter((n) => !taken(n, entry.posted_on, entry.posting_on, entry.check_on));
    for (const list of [entry.posted_on, entry.posting_on, entry.check_on, entry.failed_on]) list.sort(byTargetOrder);
  }
  return out;
}

export async function readPostTargets(tenant_id: string, deps: Pick<PostDeps, "connected"> = defaultPostDeps): Promise<PostTarget[]> {
  return Promise.all(
    POST_TARGETS.map(async (t): Promise<PostTarget> => {
      if (!t.channel) return { name: t.name, label: t.label, status: "coming_soon" };
      return { name: t.name, label: t.label, status: (await deps.connected(tenant_id, t.channel)) ? "connected" : "not_connected" };
    }),
  );
}

export async function postLibraryVideo(
  deps: PostDeps,
  args: { tenant_id: string; user_id: string; artifact_id: string; names: PostTargetName[]; caption: string | null; repost?: PostTargetName[] },
): Promise<PostOutcome[]> {
  const { tenant_id, user_id, artifact_id } = args;
  const db = deps.db(tenant_id);
  const art = await db
    .from("run_artifacts")
    .select("id, tenant_id, storage_path, bucket, filename, mime")
    .eq("id", artifact_id)
    .maybeSingle();
  if (art.error) throw new Error(`video read failed: ${art.error.message}`);
  const row = art.data as { tenant_id: string; storage_path: string; bucket: string | null; filename: string | null; mime: string | null } | null;
  if (
    !row ||
    row.tenant_id !== tenant_id ||
    !String(row.mime ?? "").startsWith("video/") ||
    !SOURCE_BUCKETS.has(row.bucket ?? "agent-artifacts") ||
    !isTenantArtifactPath(tenant_id, row.storage_path ?? "")
  ) {
    throw new PostError(404, "video_not_found", "That video was not found. Refresh the Library and try again.");
  }

  if (!(await deps.gateOpen(tenant_id))) {
    throw new PostError(403, "social_publish_paused", "Posting is paused for your account right now, so nothing was posted.");
  }

  const title = videoTitle(row.filename, row.storage_path);
  const caption = args.caption?.trim() || title;
  const names = [...new Set(args.names)];
  const outcomes: PostOutcome[] = [];
  const ready: Array<{ name: PostTargetName; channel: string }> = [];
  for (const name of names) {
    const target = POST_TARGETS.find((t) => t.name === name)!;
    if (!target.channel) {
      outcomes.push({ name, status: "coming_soon", message: `Posting to ${target.label} is not available yet.` });
      continue;
    }
    const locked = await deps.planLocked(tenant_id, target.channel);
    if (locked) {
      outcomes.push({ name, status: "failed", message: locked });
      continue;
    }
    if (!(await deps.connected(tenant_id, target.channel))) {
      outcomes.push({ name, status: "not_connected", message: `Connect ${target.label} in Settings, then post again.` });
      continue;
    }
    ready.push({ name, channel: target.channel });
  }
  if (ready.length === 0) return order(outcomes);

  const before = await readVideoDecisions(db, [artifact_id]);
  let videoPath: string | null = null;
  const pathFromPrior = () => {
    for (const d of before.decisions) {
      const p = (d.body?.payload as { video_path?: unknown } | undefined)?.video_path;
      if (typeof p === "string" && p.startsWith(`${tenant_id}/`) && VIDEO_PATH_RE.test(p)) return p;
    }
    return null;
  };
  const mediaPath = async (): Promise<string> => {
    if (videoPath) return videoPath;
    videoPath = pathFromPrior();
    if (videoPath) return videoPath;
    const file = await deps.storage(tenant_id).from(row.bucket ?? "agent-artifacts").download(row.storage_path);
    if (file.error || !file.data) throw new Error(`video read failed: ${file.error?.message ?? "empty"}`);
    const bytes = Buffer.from(await file.data.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new PostError(413, "video_too_large", "This video is over 50 MB, so it cannot be posted.");
    const path = `${tenant_id}/${randomUUID()}.mp4`;
    const up = await deps.storage(tenant_id).from(MEDIA_BUCKET).upload(path, bytes, { contentType: "video/mp4", upsert: false });
    if (up.error) throw new Error(`video copy failed: ${up.error.message}`);
    videoPath = path;
    return path;
  };

  for (const { name, channel } of ready) {
    try {
      const repost = args.repost?.includes(name) ?? false;
      outcomes.push(await postOne(deps, db, { tenant_id, user_id, artifact_id, name, channel, caption, title, repost }, before, mediaPath));
    } catch (e) {
      if (e instanceof PostError && e.code === "video_too_large") throw e;
      console.warn(`[video-studio] library post ${channel} failed: ${(e as Error).message}`);
      outcomes.push({ name, status: "failed", message: TRY_AGAIN });
    }
  }
  return order(outcomes);
}

function order(outcomes: PostOutcome[]): PostOutcome[] {
  return outcomes.sort((a, b) => POST_TARGET_NAMES.indexOf(a.name) - POST_TARGET_NAMES.indexOf(b.name));
}

const DECIDED_YES = new Set(["approved", "dispatching", "acted"]);

async function alreadyPosted(
  deps: PostDeps,
  a: { tenant_id: string; name: PostTargetName },
  winner: DecisionRow,
  posts: PostRow[],
): Promise<PostOutcome> {
  if (isUnconfirmed(winner, posts)) {
    const label = POST_TARGETS.find((t) => t.name === a.name)!.label;
    return { name: a.name, status: "failed", message: `${label} did not confirm the last post of this video, so Zavi did not send it again. Check ${label}, then post again if it is not there.` };
  }
  if (winner.status === "approved" && !posts.some((p) => p.decision_id === winner.id)) {
    await deps.redispatch(a.tenant_id, winner.id);
  }
  return { name: a.name, status: "already_posted" };
}

async function postOne(
  deps: PostDeps,
  db: Db,
  a: { tenant_id: string; user_id: string; artifact_id: string; name: PostTargetName; channel: string; caption: string; title: string; repost: boolean },
  before: { decisions: DecisionRow[]; posts: PostRow[] },
  mediaPath: () => Promise<string>,
): Promise<PostOutcome> {
  const liveFor = (s: { decisions: DecisionRow[]; posts: PostRow[] }) =>
    s.decisions.filter((d) => d.body?.channel === a.channel && isLive(d, s.posts, a.repost)).sort(oldestFirst);

  let winner = liveFor(before)[0] ?? null;
  let mine: string | null = null;
  if (!winner) {
    const payload = validateChannelPayload(a.channel, payloadFor(a.channel, a.caption, a.title, await mediaPath()));
    mine = await deps.emit(a.tenant_id, {
      channel: a.channel,
      payload,
      scheduled_at: null,
      origin: LIBRARY_POST_ORIGIN,
      source_video_id: a.artifact_id,
      post_attempt: randomUUID(),
    });
    const after = await readVideoDecisions(db, [a.artifact_id]);
    winner = liveFor(after)[0] ?? null;
    if (!winner || winner.id !== mine) {
      await deps.decide({ decision_id: mine, tenant_id: a.tenant_id, action: "reject", actor: { user_id: a.user_id } });
    }
    if (!winner && after.decisions.find((d) => d.id === mine)?.autonomy_at_emit === "forbidden") {
      const label = POST_TARGETS.find((t) => t.name === a.name)!.label;
      return { name: a.name, status: "failed", message: `Posting is turned off for ${label} in your approval settings, so nothing was posted.` };
    }
    if (!winner) return { name: a.name, status: "failed", message: TRY_AGAIN };
    if (winner.id !== mine && winner.status !== "proposed") return alreadyPosted(deps, a, winner, after.posts);
  } else if (winner.status !== "proposed") {
    return alreadyPosted(deps, a, winner, before.posts);
  }

  const text = String(payloadFor(a.channel, a.caption, a.title, "").text);
  const staged = (winner.body?.payload as { text?: unknown } | undefined)?.text;
  const res = await deps.decide({
    decision_id: winner.id,
    tenant_id: a.tenant_id,
    action: "approve",
    actor: { user_id: a.user_id },
    ...(staged === text ? {} : { payload_edit: { text } }),
  });
  if (res.ok && DECIDED_YES.has(res.status ?? "")) return { name: a.name, status: res.changed ? "posted" : "already_posted" };
  if (mine && winner.id === mine) {
    await deps.decide({ decision_id: mine, tenant_id: a.tenant_id, action: "reject", actor: { user_id: a.user_id } }).catch(() => null);
  }
  if (res.code === "not_authorized" || res.code === "not_member") {
    return { name: a.name, status: "failed", message: "Only a workspace owner or admin can post this." };
  }
  if (FOUNDER_SAFE_DETAIL.has(res.code) && res.detail) return { name: a.name, status: "failed", message: res.detail };
  return { name: a.name, status: "failed", message: TRY_AGAIN };
}
