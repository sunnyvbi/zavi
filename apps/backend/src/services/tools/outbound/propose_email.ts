
import { z } from "zod";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isOutboundEmailProducerEnabled } from "./_flag-check";
import { oneLineField } from "@/services/email-cards/variants";
import { connectedEmailSender, NO_EMAIL_SENDER_NOTE, type EmailSenderKind } from "@/services/comms/email-sender";

const inputSchema = z.object({
  to: z
    .string()
    .email()
    .max(320)
    .describe(
      "The recipient email address THE OPERATOR named. Never invent or guess a recipient — if the operator did not give you a specific address, ask them instead of calling this tool.",
    ),
  subject: oneLineField("subject", 1, 200).describe("Email subject line."),
  body_text: z
    .string()
    .min(1)
    .max(50_000)
    .describe("The full plain-text email body the operator will approve and send."),
  body_html: z
    .string()
    .max(100_000)
    .optional()
    .describe("Optional HTML body. Omit for a plain-text email."),
  rationale: z
    .string()
    .max(500)
    .optional()
    .describe("One line on why/what this email is — surfaces in Needs you next to the proposal."),
});

type ProposeEmailInput = z.infer<typeof inputSchema>;

type ProposeEmailResult = {
  decision_id: string;
  decision_class: "outbound.send";
  to: string;
  sends_from: EmailSenderKind;
};

export const proposeOutboundEmailTool: ToolSpec<
  ProposeEmailInput,
  ProposeEmailResult
> = {
  name: "outbound__propose_email",
  effect: "write",
  description:
    "Propose sending ONE email to a recipient the OPERATOR explicitly named. Emits an approval-gated proposal — it never sends; the operator approves it in Needs you and the platform sends it through the comms safety net, from the workspace's connected email account (their Gmail, or a SendGrid key). With no account connected it refuses, and the email stays a draft in your reply for the operator to send. Use only when the operator asked to email a specific person and gave (or confirmed) the address. Do NOT use for bulk/cold outreach or to a recipient you sourced yourself.",
  input_schema: inputSchema,
  async execute(
    ctx: ToolContext,
    input: ProposeEmailInput,
  ): Promise<ProposeEmailResult> {
    if (!(await isOutboundEmailProducerEnabled(ctx.tenant_id))) {
      throw new ExpectedToolError(
        "outbound_email_producer_disabled",
        "Outbound email sending is not enabled for this workspace. Draft the email in your reply for the operator to send manually.",
      );
    }
    if (!ctx.emit_decision) {
      throw new ExpectedToolError(
        "emit_unavailable",
        "Cannot propose an outbound email outside a managed agent run.",
      );
    }
    let sends_from: EmailSenderKind | null;
    try {
      sends_from = await connectedEmailSender(ctx.tenant_id);
    } catch {
      throw new ExpectedToolError(
        "email_sender_unreadable",
        "Zavi could not check which email account is connected just now, so nothing was proposed. Try again in a minute.",
      );
    }
    if (!sends_from) {
      throw new ExpectedToolError("no_email_sender", NO_EMAIL_SENDER_NOTE);
    }
    const body = {
      channel: "email" as const,
      to: input.to,
      subject: input.subject,
      body_text: input.body_text,
      ...(input.body_html ? { body_html: input.body_html } : {}),
      ...(input.rationale ? { rationale: input.rationale } : {}),
    };
    const decision_id = await ctx.emit_decision("outbound.send", body);
    return { decision_id, decision_class: "outbound.send", to: input.to, sends_from };
  },
};
