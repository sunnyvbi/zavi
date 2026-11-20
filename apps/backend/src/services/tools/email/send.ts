
import { z } from "zod";
import { emailSend } from "./_client";
import { tenantClient, asTenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  to: z.string().email("must be a valid email address"),
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(50_000),
  body_html: z.string().max(100_000).optional(),
  reply_to: z.string().email().optional(),
});

export const emailSendTool: ToolSpec = {
  name: "email_send",
  effect: "write",
  description:
    "Send a transactional email via the operator's connected SendGrid account. WRITE TOOL — only callable by the decision dispatcher after operator approval (or auto-class for templated outbound). 'to' is the recipient; 'reply_to' optional override (defaults to operator's from-address). HTML body optional — will auto-derive from text if omitted.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    await refuseSelfReply(ctx, args.to);
    const result = await emailSend(ctx.tenant_id, args);
    return {
      ok: result.ok,
      message_id: result.messageId,
      status_code: result.statusCode,
    };
  },
};

export async function emailSelfReplyReason(tenant_id: string, run_id: string, to: string): Promise<string | null> {
  const { data: run, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("trigger, payload")
    .eq("id", run_id)
    .maybeSingle<{ trigger: string | null; payload: { email?: { from?: string } } | null }>();
  if (error || !run) return "Could not check whether this email repeats the automatic reply, so it was not queued. Try again.";
  if (run.trigger !== "email") return null;
  const inboundSender = String(run.payload?.email?.from ?? "").trim().toLowerCase();
  if (!inboundSender) return "Could not read who this email-triggered run is replying to, so this email was not queued. Try again.";
  if (to.trim().toLowerCase() !== inboundSender) return null;
  return `Do NOT email ${inboundSender}: your final answer is already sent back to them by email, in-thread, automatically. Just write the answer as your response. (You may still email OTHER recipients.)`;
}

async function refuseSelfReply(
  ctx: { tenant_id: string; run_id?: string; run_trigger?: string },
  to: string,
): Promise<void> {
  if (ctx.run_trigger !== "email" || !ctx.run_id) return;

  const { data: run } = await tenantClient(asTenantId(ctx.tenant_id))
    .from("agent_runs")
    .select("payload")
    .eq("id", ctx.run_id)
    .maybeSingle<{ payload: { email?: { from?: string } } | null }>();

  const inboundSender = String(run?.payload?.email?.from ?? "").trim().toLowerCase();
  if (!inboundSender) return;

  if (to.trim().toLowerCase() === inboundSender) {
    throw new ExpectedToolError(
      "reply_is_automatic",
      `Do NOT email ${inboundSender} — your final answer is already sent back to them by email, in-thread, automatically. Just write the answer as your response. (You may still use email_send for OTHER recipients.)`,
    );
  }
}
