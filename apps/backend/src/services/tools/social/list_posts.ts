
import { z } from "zod";
import { xThreadOutcome } from "@zavi/shared";
import type { ToolSpec } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { priorConnectorTeamId } from "@/services/connectors/core/token";

const COMPOSIO_SLUG: Partial<Record<string, string>> = {
  instagram_image: "composio.instagram",
  instagram_video: "composio.instagram",
  youtube_video: "composio.youtube",
  pinterest_pin: "composio.pinterest",
  reddit: "composio.reddit",
};

const inputSchema = z.object({
  channel: z
    .enum(["x", "x_image", "x_video", "linkedin", "linkedin_image", "linkedin_video", "instagram_image", "instagram_video", "reddit", "reddit_comment", "youtube_video", "tiktok_video", "pinterest_pin"])
    .describe("Which channel's ledger to read."),
  limit: z.number().int().min(1).max(50).default(20).describe("Most recent N posts (1-50)."),
});

type Row = {
  id: string;
  account_id?: string | null;
  transport?: string | null;
  status: string;
  external_url: string | null;
  external_post_id: string | null;
  approved_payload_snapshot: { payload?: Record<string, unknown> } | null;
  metrics: Record<string, unknown> | null;
  metrics_read_at: string | null;
  last_error: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  social_publish_attempts?: Array<{ response?: unknown }>;
};

type StagedRow = {
  id: string;
  body: { scheduled_at?: string | null; payload?: Record<string, unknown> } | null;
  emitted_at: string;
};

const MEDIA_FIELDS = ["title", "image_path", "video_path", "board_id", "board_name", "link", "alt_text"] as const;

function mediaFields(p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of MEDIA_FIELDS) if (typeof p[k] === "string") out[k] = p[k] as string;
  return out;
}

export function shapeStagedRow(r: StagedRow) {
  const p = r.body?.payload ?? {};
  return {
    id: r.id,
    status: "awaiting_approval",
    text: typeof p.text === "string" ? p.text : null,
    ...mediaFields(p),
    scheduled_at: r.body?.scheduled_at ?? null,
    created_at: r.emitted_at,
  };
}

export function shapeLedgerRow(r: Row, connectedId: string | null = null) {
  const p = r.approved_payload_snapshot?.payload ?? {};
  const sameConnection = connectedId && r.transport === "composio" && r.account_id
    ? r.account_id === connectedId : null;
  return {
    id: r.id,
    status: r.status,
    to_current_connection: sameConnection,
    to_connected_account: r.status === "published" && sameConnection === true ? true : null,
    text: typeof p.text === "string" ? p.text : null,
    thread: Array.isArray(p.thread) ? (p.thread as string[]) : undefined,
    partial_thread: Array.isArray(p.thread) && r.status === "published"
      ? xThreadOutcome(r.social_publish_attempts?.[0]?.response, p.thread.length + 1)
      : null,
    ...mediaFields(p),
    external_url: r.external_url,
    external_post_id: r.external_post_id,
    metrics: r.metrics,
    metrics_read_at: r.metrics_read_at,
    last_error: r.last_error,
    scheduled_at: r.scheduled_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const socialListPostsTool: ToolSpec = {
  name: "social_list_posts",
  effect: "read",
  description:
    "Zavi's own ledger of posts approved for this workspace on one channel: text, status (approved/scheduled/publishing/published/failed/cancelled), the approval cards still waiting on the founder under `staged` (with image_path, title, board and link to reuse), the live link when published, the last error, and the metrics snapshot from the last connected read. Read it BEFORE writing new posts so the next batch differs from what was already said, and to report what was published and what it did.",
  input_schema: inputSchema,
  execute: async (ctx, rawInput) => {
    const input = inputSchema.parse(rawInput);
    const db = tenantClient(asTenantId(ctx.tenant_id));
    const [{ data, error }, pending] = await Promise.all([
      db
        .from("social_posts")
        .select(
          "id, account_id, transport, status, external_url, external_post_id, approved_payload_snapshot, metrics, metrics_read_at, last_error, scheduled_at, created_at, updated_at, social_publish_attempts(response)",
        )
        .eq("channel", input.channel)
        .order("created_at", { ascending: false, referencedTable: "social_publish_attempts" })
        .limit(1, { referencedTable: "social_publish_attempts" })
        .order("created_at", { ascending: false })
        .limit(input.limit),
      db
        .from("customer_visible_pending_decisions")
        .select("id, body, emitted_at")
        .eq("decision_class", "social.publish.v2")
        .eq("body->>channel", input.channel)
        .order("emitted_at", { ascending: false })
        .limit(input.limit),
    ]);
    if (error) throw new Error(`social_posts read failed: ${error.message}`);
    if (pending.error) throw new Error(`staged posts read failed: ${pending.error.message}`);
    const rows = (data ?? []) as Row[];
    const staged = ((pending.data ?? []) as StagedRow[]).map(shapeStagedRow);
    const slug = COMPOSIO_SLUG[input.channel];
    const connectedId = slug ? await priorConnectorTeamId(ctx.tenant_id, slug).catch(() => null) : null;
    return {
      channel: input.channel,
      count: rows.length,
      posts: rows.map((r) => shapeLedgerRow(r, connectedId)),
      staged_count: staged.length,
      staged,
      note:
        rows.length === 0 && staged.length === 0
          ? "No approved posts or pending approval cards are recorded on this channel yet."
          : "staged lists approval cards the founder has not approved yet; none of them is published. Metrics are a snapshot from the last connected read (metrics_read_at); a published post with no snapshot has not been read yet. to_current_connection compares the login saved at approval to the current login. False means a different connection, which may still be the same account after reconnecting. to_connected_account is true only for a published post on the current connection; null means the destination account is unknown. A queued or failed post is not proof of publication.",
    };
  },
};
