
import { z } from "zod";
import { slackFetch } from "./_client";
import { uploadFileToThread } from "./upload_file";
import { looksLikeChannelId, resolveChannelId } from "./_resolve_channel";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

const MAX_CONTENT_BYTES = 1024 * 1024;

const inputSchema = z
  .object({
    channel_id: z.string().min(1).optional(),
    user_id: z
      .string()
      .min(1)
      .optional()
      .describe("Slack user_id (U...) to DM the file to — auto-opens the DM."),
    user_ids: z
      .array(z.string().min(1))
      .min(2)
      .max(8)
      .optional()
      .describe("2-8 Slack user_ids for a group DM (mpim) — auto-opened."),
    filename: z
      .string()
      .min(1)
      .max(200)
      .describe("File name including extension, e.g. report.csv or notes.md."),
    content: z
      .string()
      .min(1)
      .describe("The file's text content (CSV / markdown / plaintext). Max 1MB."),
    title: z.string().max(200).optional(),
    thread_ts: z
      .string()
      .optional()
      .describe("Reply/attach inside an existing thread."),
  })
  .refine(
    (v) =>
      [v.channel_id, v.user_id, v.user_ids].filter((x) => x !== undefined)
        .length === 1,
    {
      message:
        "Provide exactly one of: channel_id, user_id (1:1 DM), or user_ids (group DM).",
    },
  );

type OpenResp = { channel?: { id?: string } };

export const uploadFileTool: ToolSpec = {
  name: "slack_upload_file",
  effect: "write",
  description:
    "Attach a text file (CSV, markdown, or plaintext) into a Slack channel, DM, or thread. Provide the file CONTENT inline as text plus a filename. Target EXACTLY ONE of channel_id / user_id / user_ids (user targets auto-open the DM). Use this to deliver a report, export, or summary as a downloadable file rather than a long chat message. Max 1MB of content.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    const bytes = new TextEncoder().encode(args.content);
    if (bytes.byteLength > MAX_CONTENT_BYTES) {
      throw new ExpectedToolError(
        "slack_upload_too_large",
        `File content is ${bytes.byteLength} bytes; max is ${MAX_CONTENT_BYTES}. Trim it or split into multiple files.`,
      );
    }

    let channel = args.channel_id;
    if (channel && !looksLikeChannelId(channel)) {
      channel = await resolveChannelId(ctx.tenant_id, channel, ctx.slack_team_id);
    }
    if (!channel) {
      const users = args.user_id ? [args.user_id] : args.user_ids!;
      const open = await slackFetch<OpenResp>(
        ctx.tenant_id,
        "conversations.open",
        { users: users.join(",") },
        ctx.slack_team_id,
      );
      channel = open.channel?.id;
      if (!channel) {
        throw new ExpectedToolError(
          "slack_dm_open_failed",
          "Could not open a DM channel for the given user(s).",
          { user_count: users.length },
        );
      }
    }

    const { file_id } = await uploadFileToThread({
      tenant_id: ctx.tenant_id,
      channel_id: channel,
      thread_ts: args.thread_ts,
      bytes,
      filename: args.filename,
      title: args.title,
      team_id: ctx.slack_team_id,
    });

    return { file_id, channel };
  },
};
