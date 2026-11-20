
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { resolveChannelExecEmit, type EmitDecisionFn, type ExecEmitCtx } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { cardSubject, EMAIL_SEND_CLASS, emailSendBodySchema, parseEmailSendBody, sealedCredentialOf, type EmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_TOOL_LABEL } from "@/services/connectors/email-campaign/providers";

const SWITCHED_EMAIL_CHANNELS: ReadonlySet<string> = new Set(["email_marketing"]);

export function buildEmailSendCardBody(body: EmailSendBody, rationale: string | null): { title: string; card: Record<string, unknown> } {
  const tool = EMAIL_TOOL_LABEL[body.tool];
  const subject = cardSubject(body);
  const title = `Send "${subject}" to ${body.audience_name}`.slice(0, 300);
  const sentence = `Zavi creates this email in ${tool} and sends it to your "${body.audience_name}" list. ${tool} applies its own unsubscribes.`;
  const versions = body.variants ?? [];
  const deliverable =
    versions.length > 0
      ? {
          kind: "email",
          label: subject,
          content: versions.map((v, i) => `Version ${i + 1}: ${v.content.subject}\n\n${v.text}`).join("\n\n"),
        }
      : { kind: "email", label: subject, content: body.body_text ?? "" };
  const subjectRows =
    versions.length > 0
      ? versions.map((v, i) => ({ item: `Version ${i + 1}`, before: "", after: v.content.subject }))
      : [
          { item: "Subject", before: "", after: subject },
          ...(body.preview_text ? [{ item: "Preview", before: "", after: body.preview_text }] : []),
        ];
  return {
    title,
    card: {
      step: {
        title,
        body: [sentence, rationale?.trim()].filter(Boolean).join("\n\n"),
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable,
      },
      change_sentence: sentence,
      exact_change: {
        rows: [
          ...subjectRows,
          { item: "From", before: "", after: `${body.from_name} <${body.from_email}>` },
          ...(body.reply_to ? [{ item: "Replies go to", before: "", after: body.reply_to }] : []),
          { item: "Sending with", before: "", after: tool },
          { item: "List", before: "", after: body.audience_name },
        ],
      },
      decision_evidence: null,
      link: null,
    },
  };
}

export async function resolveEmailCampaignEmit(ctx: ExecEmitCtx): Promise<EmitDecisionFn | undefined> {
  return resolveChannelExecEmit(SWITCHED_EMAIL_CHANNELS, ctx, async (a) => {
    if (a.decision_class !== EMAIL_SEND_CLASS) {
      throw new ExpectedToolError(
        "channel_action_class_unknown",
        `Zavi does not know where a ${a.decision_class} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
      );
    }
    const { rationale, ...rest } = a.body as { rationale?: unknown };
    const sealed = emailSendBodySchema.strict().safeParse(rest);
    if (!sealed.success || !sealedCredentialOf(sealed.data) || !parseEmailSendBody(sealed.data) || sealed.data.chosen_variant !== undefined || sealed.data.approved_count !== undefined) {
      throw new ExpectedToolError("email_campaign_body_invalid", "The send proposal was not in the expected shape, so nothing was filed. This is a Zavi bug, not something to retry.");
    }
    const payload: EmailSendBody = sealed.data;
    const { title, card } = buildEmailSendCardBody(payload, typeof rationale === "string" ? rationale : null);
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: payload,
      actionType: "send_message",
      title,
      body: card,
    });
    return id;
  });
}
