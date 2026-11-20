
import { savedPostDraftSchema, type SavedPostDraft } from "@zavi/shared";
import { z } from "zod";
import { socialDraftVersion } from "@/services/approvals/social-draft-version";
import type { DashboardContext } from "@/routes/agents/dashboards/_contract";

export const X_CHANNELS = new Set(["x", "x_image", "x_video"]);
export const LINKEDIN_CHANNELS = new Set(["linkedin", "linkedin_image", "linkedin_video"]);
export const INSTAGRAM_CHANNELS = new Set(["instagram_image", "instagram_video"]);
export const TIKTOK_CHANNELS = new Set(["tiktok_video"]);
export const REDDIT_CHANNELS = new Set(["reddit", "reddit_comment"]);

const CONFIRM_RE = /\$[\d,]|\b\d{1,3}(?:,\d{3})+\b|\b(?:today|tomorrow|tonight)\b/i;

export type StagedDraft = {
  post_revision: string;
  edited_body?: SavedPostDraft;
  original_text?: string;
  original_thread?: string[] | null;
  original_image_path?: string | null;
  decision_id: string;
  source: "staged";
  label: null;
  needs_confirm: boolean;
  channel: string;
  text: string;
  thread: string[] | null;
  image_path: string | null;
  video_path: string | null;
  scheduled_at: string | null;
  rationale: string | null;
  emitted_at: string;
  snoozed_until: string | null;
  title?: string;
  subreddit?: string;
  thread_url?: string;
};

type DecisionRow = {
  id: string;
  body: Record<string, unknown> | null;
  emitted_at: string;
  snoozed_until: string | null;
};

export async function stagedDrafts(
  c: DashboardContext,
  channels: ReadonlySet<string>,
): Promise<StagedDraft[] | null> {
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, body, emitted_at, agent_run_id, snoozed_until")
      .eq("tenant_id", c.tenantId)
      .eq("status", "proposed")
      .eq("decision_class", "social.publish.v2")
      .in("body->>channel", [...channels])
      .order("emitted_at", { ascending: false })
      .limit(100);
    if (error || !Array.isArray(data)) return null;
    const out: StagedDraft[] = [];
    for (const d of data as DecisionRow[]) {
      const b = d.body ?? {};
      const channel = typeof b.channel === "string" ? b.channel : "";
      if (!channels.has(channel)) continue;
      const payload = (b.payload ?? {}) as Record<string, unknown>;
      const text = typeof payload.text === "string" ? payload.text : "";
      const edited = savedPostDraftSchema.safeParse(b.post_draft);
      const original = z.object({ payload: z.object({ text: z.string(), thread: z.array(z.string()).nullable().optional(), image_path: z.string().nullable().optional() }) }).safeParse(b.post_draft_original);
      out.push({
        post_revision: socialDraftVersion(b),
        ...(edited.success ? { edited_body: edited.data } : {}),
        ...(original.success ? { original_text: original.data.payload.text, original_thread: original.data.payload.thread ?? null, original_image_path: original.data.payload.image_path ?? null } : {}),
        decision_id: d.id,
        source: "staged",
        label: null,
        needs_confirm: CONFIRM_RE.test(text),
        channel,
        text,
        thread: Array.isArray(payload.thread) ? (payload.thread as string[]) : null,
        image_path: typeof payload.image_path === "string" ? payload.image_path : null,
        video_path: typeof payload.video_path === "string" ? payload.video_path : null,
        scheduled_at: typeof b.scheduled_at === "string" ? b.scheduled_at : null,
        rationale: typeof b.rationale === "string" ? b.rationale : null,
        emitted_at: d.emitted_at,
        snoozed_until: d.snoozed_until ?? null,
        ...(["title", "subreddit", "thread_url"] as const).reduce(
          (o, k) => (typeof payload[k] === "string" ? { ...o, [k]: payload[k] } : o),
          {},
        ),
      });
    }
    return out;
  } catch {
    return null;
  }
}
