
import { z } from "zod";
import { downloadSlackFileBytes, slackFetch } from "./_client";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  file_id: z.string().min(1),
});

const MAX_TEXT_CHARS = 24_000;

type SlackFileInfo = {
  file?: {
    id?: string;
    name?: string;
    filetype?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
  };
};

type ArtifactRow = {
  id: string;
  filename: string;
  render_input: unknown | null;
};

type RunRow = {
  tenant_id: string;
  payload: {
    slack?: { channel_id?: string; thread_ts?: string; team_id?: string };
  } | null;
};

export function renderInputToText(input: unknown): string {
  const doc = input as
    | {
        title?: string;
        sections?: Array<{
          heading?: string;
          body_markdown?: string;
          preformatted?: string;
          table?: { columns?: string[]; rows?: string[][] };
        }>;
      }
    | null;
  if (!doc || !Array.isArray(doc.sections)) return "";
  const parts: string[] = [];
  if (doc.title) parts.push(`# ${doc.title}`);
  for (const s of doc.sections) {
    if (s.heading) parts.push(`## ${s.heading}`);
    if (s.body_markdown) parts.push(s.body_markdown);
    if (s.preformatted) parts.push("```\n" + s.preformatted + "\n```");
    if (s.table?.columns?.length) {
      parts.push(`| ${s.table.columns.join(" | ")} |`);
      parts.push(`| ${s.table.columns.map(() => "---").join(" | ")} |`);
      for (const row of s.table.rows ?? []) parts.push(`| ${row.join(" | ")} |`);
    }
  }
  return parts.join("\n\n").trim();
}

export async function extractText(
  bytes: Buffer,
  filetype: string,
  filename: string,
): Promise<string> {
  const ft = (filetype || filename.split(".").pop() || "").toLowerCase();

  if (ft === "pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const out = await pdfParse(bytes);
    return (out.text ?? "").trim();
  }
  if (ft === "docx" || ft === "doc") {
    const mammoth = await import("mammoth");
    const out = await mammoth.extractRawText({ buffer: bytes });
    return (out.value ?? "").trim();
  }
  if (["text", "txt", "markdown", "md", "csv", "json", "yaml", "yml"].includes(ft)) {
    return bytes.toString("utf-8").trim();
  }
  throw new ExpectedToolError(
    "file_unreadable",
    `Cannot extract text from a ".${ft}" file. Supported: pdf, docx, txt, md, csv. Ask the user to paste the contents or re-share as a supported type.`,
    { filetype: ft },
  );
}

const MEMBERSHIP_PAGE_LIMIT = 200;
const MEMBERSHIP_MAX_PAGES = 4;

async function fileIsInThread(
  tenant_id: string,
  channel: string,
  thread_ts: string,
  file_id: string,
  team_id?: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERSHIP_MAX_PAGES; page++) {
    const json = await slackFetch<{
      messages?: Array<{ files?: Array<{ id?: string }> }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>(
      tenant_id,
      "conversations.replies",
      {
        channel,
        ts: thread_ts,
        limit: MEMBERSHIP_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      team_id,
    );
    const hit = (json.messages ?? []).some((m) =>
      (m.files ?? []).some((f) => f.id === file_id),
    );
    if (hit) return true;
    cursor = json.response_metadata?.next_cursor;
    if (!json.has_more || !cursor) break;
  }
  return false;
}

export const readFileTool: ToolSpec = {
  name: "slack_read_file",
  effect: "read",
  description:
    "Read the CONTENTS of a document attached to the current Slack thread. Pass a file_id from slack_read_thread's `files` array. Returns the extracted text (pdf, docx, txt, md, csv). Use this whenever the user refers to an attached plan, spec, or document — never guess what a document says.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "file_unreadable",
        "No run context — cannot verify this file belongs to the current thread.",
        {},
      );
    }

    const tid = asTenantId(ctx.tenant_id);
    const { data: run } = await tenantClient(tid)
      .from("agent_runs")
      .select("tenant_id, payload")
      .eq("id", ctx.run_id)
      .maybeSingle<RunRow>();

    const slack = run?.payload?.slack;
    if (!run || !slack?.channel_id || !slack.thread_ts) {
      throw new ExpectedToolError(
        "file_unreadable",
        "This run is not bound to a Slack thread, so no attached file can be read.",
        {},
      );
    }
    if (run.tenant_id !== ctx.tenant_id) {
      throw new ExpectedToolError("file_unreadable", "Run/tenant mismatch.", {});
    }

    const inThread = await fileIsInThread(
      ctx.tenant_id,
      slack.channel_id,
      slack.thread_ts,
      args.file_id,
      slack.team_id ?? ctx.slack_team_id,
    );
    if (!inThread) {
      throw new ExpectedToolError(
        "file_not_in_thread",
        `File ${args.file_id} is not attached to this thread. You may only read files shared in the thread you are working in.`,
        { file_id: args.file_id },
      );
    }

    const teamId = slack.team_id ?? ctx.slack_team_id;
    let artifactQuery = tenantClient(tid)
      .from("run_artifacts")
      .select("id, filename, render_input")
      .eq("slack_file_id", args.file_id);
    if (teamId) artifactQuery = artifactQuery.eq("slack_team_id", teamId);

    const { data: artifact } = await artifactQuery.maybeSingle<ArtifactRow>();

    if (artifact?.render_input) {
      const text = renderInputToText(artifact.render_input);
      if (text.length > 0) {
        return {
          file_id: args.file_id,
          filename: artifact.filename,
          source: "run_artifact" as const,
          artifact_id: artifact.id,
          chars: text.length,
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS,
        };
      }
    }

    const info = await slackFetch<SlackFileInfo>(
      ctx.tenant_id,
      "files.info",
      { file: args.file_id },
      teamId,
    );
    const f = info.file;
    if (!f?.url_private) {
      throw new ExpectedToolError(
        "file_unreadable",
        `Slack did not return a download URL for ${args.file_id} (the bot may lack the files:read scope, or the file was deleted). Ask the user to paste the contents.`,
        { file_id: args.file_id },
      );
    }

    const bytes = await downloadSlackFileBytes(
      ctx.tenant_id,
      f.url_private,
      teamId,
    );
    if (!bytes) {
      throw new ExpectedToolError(
        "file_unreadable",
        `Could not download "${f.name ?? args.file_id}" from Slack (it may exceed the 5MB limit, or the bot may lack the files:read scope). Do NOT guess its contents — ask the user to paste them.`,
        { file_id: args.file_id },
      );
    }

    const text = await extractText(bytes, f.filetype ?? "", f.name ?? "");
    if (text.trim().length === 0) {
      throw new ExpectedToolError(
        "file_unreadable",
        `"${f.name ?? args.file_id}" contained no extractable text (it may be a scanned image). Do NOT guess its contents — ask the user to paste them.`,
        { file_id: args.file_id },
      );
    }

    return {
      file_id: args.file_id,
      filename: f.name ?? args.file_id,
      source: "slack_file" as const,
      artifact_id: artifact?.id ?? null,
      chars: text.length,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    };
  },
};
