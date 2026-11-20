
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  hasAnyRetrieval,
  hasRetrievedAnyOf,
  recordThreadAttachments,
  retrievalFailures,
  threadAttachments,
  type ThreadAttachment,
} from "./doc-ledger";

const REFERENT_RE =
  /\b(this|that|the|the above|the attached)\s+(plan|spec|doc|document|pdf|file|attachment)\b/i;

const DOC_FILETYPES = new Set([
  "pdf",
  "doc",
  "docx",
  "text",
  "txt",
  "markdown",
  "md",
  "csv",
  "rtf",
]);

export function mentionsDocumentReferent(text: string | null | undefined): boolean {
  if (!text) return false;
  return REFERENT_RE.test(text);
}

export function isEligibleDoc(f: { filetype?: string; name?: string }): boolean {
  const ft = (f.filetype ?? "").toLowerCase();
  if (DOC_FILETYPES.has(ft)) return true;
  const ext = (f.name ?? "").toLowerCase().split(".").pop() ?? "";
  return DOC_FILETYPES.has(ext);
}

type SlackPayload = {
  channel_id?: string;
  thread_ts?: string;
  original_ts?: string;
  text?: string;
  team_id?: string;
};

type RunRow = {
  tenant_id: string;
  trigger: string;
  payload: { slack?: SlackPayload } | null;
};

async function rederiveThreadAttachments(
  tenant_id: string,
  slack: SlackPayload,
): Promise<ThreadAttachment[] | null> {
  const channel = slack.channel_id;
  const ts = slack.thread_ts;
  if (!channel || !ts) return null;
  try {
    const msgs: Array<{
      ts?: string;
      files?: Array<{ id?: string; name?: string; filetype?: string }>;
    }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const json = await slackFetch<{
        messages?: Array<{
          ts?: string;
          files?: Array<{ id?: string; name?: string; filetype?: string }>;
        }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>(
        tenant_id,
        "conversations.replies",
        { channel, ts, limit: 200, ...(cursor ? { cursor } : {}) },
        slack.team_id,
      );
      msgs.push(...(json.messages ?? []));
      cursor = json.response_metadata?.next_cursor;
      if (!json.has_more || !cursor) break;
    }
    if (msgs.length === 0) return [];

    const rootTs = msgs[0]?.ts;
    const currentTs = slack.original_ts ?? msgs[msgs.length - 1]?.ts;
    const out: ThreadAttachment[] = [];
    for (const m of msgs) {
      if (m.ts !== rootTs && m.ts !== currentTs) continue;
      for (const f of m.files ?? []) {
        if (!f.id) continue;
        const att = {
          file_id: String(f.id),
          name: String(f.name ?? "file"),
          filetype: String(f.filetype ?? ""),
        };
        if (isEligibleDoc(att)) out.push(att);
      }
    }
    return out;
  } catch {
    return null;
  }
}

export type ReferentGateResult =
  | { ok: true }
  | { ok: false; reason: string; files: ThreadAttachment[] };

export async function checkReferentResolved(
  run_id: string,
  opts: { tenant_id: string; isSlackRun?: boolean },
): Promise<ReferentGateResult> {
  if (!run_id || !opts.tenant_id) return { ok: true };

  if (opts.isSlackRun === false) return { ok: true };
  if (hasAnyRetrieval(run_id)) return { ok: true };

  let data: RunRow | null = null;
  try {
    const res = await tenantClient(asTenantId(opts.tenant_id))
      .from("agent_runs")
      .select("tenant_id, trigger, payload")
      .eq("id", run_id)
      .maybeSingle<RunRow>();
    data = res.data ?? null;
  } catch {
    return { ok: true };
  }

  if (!data || data.trigger !== "slack") return { ok: true };
  const slack = data.payload?.slack;
  if (!slack) return { ok: true };

  if (!mentionsDocumentReferent(slack.text)) return { ok: true };

  let files = threadAttachments(run_id).filter(isEligibleDoc);
  if (files.length === 0) {
    const rederived = await rederiveThreadAttachments(data.tenant_id, slack);
    if (rederived === null) {
      return {
        ok: false,
        reason:
          "could not verify whether the thread has an attachment, and no document has been read this run",
        files: [],
      };
    }
    if (rederived.length > 0) recordThreadAttachments(run_id, rederived);
    files = rederived;
  }

  if (files.length === 0) return { ok: true };

  if (hasRetrievedAnyOf(run_id, files.map((f) => f.file_id))) return { ok: true };

  return {
    ok: false,
    reason: "the thread has an attachment that was never read",
    files,
  };
}

export async function assertReferentResolved(
  run_id: string,
  action: string,
  opts: { tenant_id: string; isSlackRun?: boolean },
): Promise<void> {
  const res = await checkReferentResolved(run_id, opts);
  if (res.ok) return;

  const failed = retrievalFailures(run_id);
  const fileList = res.files
    .map((f) => `${f.name} (file_id: ${f.file_id})`)
    .join(", ");

  const detail = fileList
    ? `Read it first: slack_read_file with one of — ${fileList}.`
    : "";
  const failedNote = failed.length
    ? ` A read was already attempted and failed (${failed
        .map((f) => f.reason)
        .join("; ")}) — do NOT guess the contents; ask the user to paste the plan.`
    : "";

  throw new ExpectedToolError(
    "referent_unresolved",
    `Refusing to ${action}: the request points at a document ("this plan"/"the attached spec"), but ${res.reason}. ` +
      `${detail}${failedNote} Do NOT substitute a task from memory or prior context — if you cannot read the document, say so and ask.`,
    { action, files: res.files.map((f) => f.file_id) },
  );
}
