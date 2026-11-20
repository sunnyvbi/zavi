
import { serviceClient } from "@/services/supabase";
import {
  resolveVisibilityBulkBySlackUser,
  type SlackIndexRow,
} from "@/services/slack/permission-resolver";

const ROLLOVER_KEY = "slack_cross_surface_rollover";

async function rolloverEnabled(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
): Promise<boolean> {
  const { data: tRow, error: tErr } = await sb
    .from("tenant_app_setting")
    .select("value")
    .eq("tenant_id", tenant_id)
    .eq("key", ROLLOVER_KEY)
    .maybeSingle<{ value: unknown }>();
  if (tErr) return false;
  if (tRow && tRow.value != null) return tRow.value === true;

  const { data: gRow, error: gErr } = await sb
    .from("app_setting")
    .select("value")
    .eq("key", ROLLOVER_KEY)
    .maybeSingle<{ value: unknown }>();
  if (gErr) return false;
  if (gRow && gRow.value != null) return gRow.value === true;

  return true;
}

const MAX_CANDIDATES = 30;
const MAX_THREADS = 3;
const MAX_BLOCK_BYTES = 4096;
const MAX_EXCERPT_CHARS = 500;

type CandidateRow = SlackIndexRow & {
  ts: string;
  thread_ts: string | null;
  text_redacted: string;
  source_team_id: string;
};

export function extractKeywords(text: string): string[] {
  const stop = new Set([
    "this", "that", "with", "from", "what", "when", "where", "which", "your",
    "have", "about", "would", "could", "should", "please", "there", "their",
    "them", "then", "than", "into", "just", "like", "want", "need", "will",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length <= 3 || stop.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 4) break;
  }
  return out;
}

export async function retrieveRelatedSlackContext(args: {
  tenant_id: string;
  team_id: string;
  asker_slack_user_id: string;
  exclude_ts: string;
  query_text: string;
}): Promise<string> {
  const { tenant_id, team_id, asker_slack_user_id, exclude_ts, query_text } = args;
  if (!tenant_id || !team_id || !asker_slack_user_id) return "";

  try {
    const sb = serviceClient();

    if (!(await rolloverEnabled(sb, tenant_id))) return "";

    const { data: state, error: stateErr } = await sb
      .from("tenant_slack_index_state")
      .select("disabled_at")
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ disabled_at: string | null }>();
    if (stateErr) return "";
    if (state?.disabled_at) return "";

    const keywords = extractKeywords(query_text);
    if (keywords.length === 0) return "";
    const orFilter = keywords
      .map((k) => `text_redacted.ilike.%${k.replace(/[%,()]/g, "")}%`)
      .join(",");

    let q = sb
      .from("slack_message_index")
      .select("channel_id, ts, thread_ts, text_redacted, conversation_type, source_user_ids, source_team_id")
      .eq("tenant_id", tenant_id)
      .eq("source_team_id", team_id)
      .neq("ts", exclude_ts)
      .or(orFilter)
      .order("ts", { ascending: false })
      .limit(MAX_CANDIDATES);
    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) return "";
    const candidates = (rows ?? []) as CandidateRow[];
    if (candidates.length === 0) return "";

    let verdicts;
    try {
      verdicts = await resolveVisibilityBulkBySlackUser({
        tenant_id,
        team_id,
        asker_slack_user_id,
        candidate_rows: candidates.map((c) => ({
          channel_id: c.channel_id,
          conversation_type: c.conversation_type,
          source_user_ids: c.source_user_ids ?? [],
          source_team_id: c.source_team_id,
        })),
      });
    } catch {
      return "";
    }
    const visible: CandidateRow[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (verdicts[i]?.visible) visible.push(candidates[i]);
    }
    if (visible.length === 0) return "";

    const seenThreads = new Set<string>();
    const picked: CandidateRow[] = [];
    for (const r of visible) {
      const key = `${r.channel_id}:${r.thread_ts ?? r.ts}`;
      if (seenThreads.has(key)) continue;
      seenThreads.add(key);
      picked.push(r);
      if (picked.length >= MAX_THREADS) break;
    }

    return buildContextBlock(picked);
  } catch {
    return "";
  }
}

export function buildContextBlock(rows: Array<{ text_redacted: string }>): string {
  if (rows.length === 0) return "";
  const header =
    "Related context from this person's earlier Slack conversations (already permission-checked — reference it only if relevant, do not repeat it verbatim):";
  const lines: string[] = [header];
  for (const r of rows) {
    const excerpt = (r.text_redacted ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
    if (!excerpt) continue;
    const candidate = `- ${excerpt}`;
    const projected = [...lines, candidate].join("\n");
    if (Buffer.byteLength(projected, "utf8") > MAX_BLOCK_BYTES) break;
    lines.push(candidate);
  }
  if (lines.length === 1) return "";
  return lines.join("\n");
}
