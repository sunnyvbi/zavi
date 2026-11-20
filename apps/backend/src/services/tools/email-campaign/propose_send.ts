
import { z } from "zod";
import { rationaleOptional } from "@/services/tools/_shared/rationale";
import { accountCall, credentialFor, resolveEmailTool } from "@/services/connectors/email-campaign/account";
import { EMAIL_ADDRESS, EMAIL_SEND_CLASS, type EmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, EMAIL_TOOLS, EmailToolError, type Audience } from "@/services/connectors/email-campaign/providers";
import type { ToolSpec } from "@/services/tools/types";
import { oneLineField } from "@/services/email-cards/variants";
import { ExpectedToolError } from "@/services/tools/types";

const inputSchema = z.object({
  tool: z.enum(EMAIL_TOOLS).optional().describe("Which email tool. Leave out when only one is connected."),
  audience_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "audience_id must be a bare list id")
    .describe("The list to send to, from email_campaign_list_audiences."),
  subject: oneLineField("subject", 1, 200).describe("The subject line."),
  preview_text: oneLineField("preview text", 0, 200).optional().describe("The preview line shown after the subject in an inbox."),
  body_text: z
    .string()
    .min(1)
    .max(100_000)
    .describe("The email as plain text, with web addresses written out in full. The founder approves exactly this text; Zavi formats it for sending (paragraphs, and a link for each address). Do not write HTML."),
  from_name: oneLineField("sender name", 0, 100).optional().describe("The sender name. Leave out to use the tool's default sender."),
  from_email: z
    .string()
    .max(320)
    .optional()
    .describe("The sender address, only when the tool has no default sender (the tool answers email_sender_unknown). It must be an address the founder has set up to send from in that tool."),
  rationale: rationaleOptional().describe("Why this email, to this list, now."),
});

export const emailCampaignProposeSendTool: ToolSpec = {
  name: "email_campaign_propose_send",
  effect: "write",
  description:
    "Propose sending one email to one list in the founder's connected email tool (Mailchimp, Klaviyo or SendGrid). Files an approval card showing " +
    "the subject, the email, the tool, the list and how many people are on it. Nothing is created or sent until it is approved; on " +
    "approval Zavi creates the campaign in that tool and sends it. Say a send happened only after the card reports it. " +
    "Throws email_tool_not_connected when no email tool is connected: write the email as a draft instead.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError("email_campaign_propose_unavailable", "This run cannot file an approval card, so nothing was proposed. Write the email as a draft for the founder instead.");
    }
    const resolved = await resolveEmailTool(ctx.tenant_id, args.tool);
    const label = EMAIL_TOOL_LABEL[resolved.tool];
    let audience: Audience | null;
    try {
      audience = await EMAIL_PROVIDERS[resolved.tool].getAudience(accountCall(resolved), args.audience_id);
    } catch (e) {
      if (e instanceof EmailToolError) throw new ExpectedToolError("email_tool_read_failed", `${label} could not be read: ${e.message}`);
      throw e;
    }
    if (!audience) {
      throw new ExpectedToolError("email_audience_missing", `No list ${args.audience_id} in the connected ${label} account. Read the lists with email_campaign_list_audiences.`);
    }
    if (audience.member_count === null) {
      throw new ExpectedToolError("email_audience_size_unknown", `${label} did not report how many people are on "${audience.name}", so the card cannot show it. Nothing was proposed.`);
    }
    if (audience.member_count === 0) {
      throw new ExpectedToolError("email_audience_empty", `"${audience.name}" has nobody on it in ${label}, so there is nobody to send to.`);
    }
    let fallback: { name: string | null; email: string | null };
    try {
      fallback = await EMAIL_PROVIDERS[resolved.tool].defaultSender(accountCall(resolved), audience);
    } catch {
      fallback = { name: null, email: null };
    }
    const fromName = (args.from_name?.trim() || fallback.name || "").slice(0, 100);
    const fromEmail = (fallback.email || args.from_email?.trim() || "").toLowerCase();
    if (!fromName || !EMAIL_ADDRESS.test(fromEmail)) {
      throw new ExpectedToolError(
        "email_sender_unknown",
        `${label} has no default sender ${fromName ? "address" : "name and address"} for this list. Ask the founder which name and address to send from, then call again with from_name and from_email. Nothing was proposed.`,
      );
    }
    let sendIds: { sender_id: string; suppression_group_id: string } | null = null;
    const resolveIds = EMAIL_PROVIDERS[resolved.tool].resolveSendIds;
    if (resolved.tool === "sendgrid" && resolveIds) {
      try {
        sendIds = await resolveIds(accountCall(resolved), fromEmail);
      } catch (e) {
        if (e instanceof EmailToolError) throw new ExpectedToolError("email_sender_unknown", `${label}: ${e.message}. Nothing was proposed.`);
        throw e;
      }
    }
    const body: EmailSendBody & { rationale: string | null } = {
      tool: resolved.tool,
      ...(resolved.tool === "sendgrid"
        ? { credential: credentialFor(resolved) }
        : { connected_account_id: resolved.account.connected_account_id, auth_config_id: resolved.account.auth_config_id }),
      audience_id: audience.id,
      audience_name: audience.name.slice(0, 300),
      audience_count: audience.member_count,
      subject: args.subject,
      preview_text: args.preview_text?.trim() || null,
      body_text: args.body_text,
      from_name: fromName,
      from_email: fromEmail,
      reply_to: null,
      ...(sendIds ? { sendgrid_sender_id: sendIds.sender_id, sendgrid_suppression_group_id: sendIds.suppression_group_id } : {}),
      rationale: args.rationale?.trim() ? args.rationale : null,
    };
    const action_id = await ctx.emit_decision(EMAIL_SEND_CLASS, body);
    return {
      action_id,
      status: "waiting_for_founder",
      tool: resolved.tool,
      audience: { id: audience.id, name: audience.name, member_count: audience.member_count },
      note: "Nothing is sent until the founder approves the card. Do not say it was sent.",
    };
  },
};
