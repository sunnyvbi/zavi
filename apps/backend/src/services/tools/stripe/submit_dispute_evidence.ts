
import { z } from "zod";
import { stripeClient, wrapStripeError } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  dispute_id: z
    .string()
    .regex(
      /^d[pu]_[A-Za-z0-9]+$/,
      "must be a Stripe dispute id (du_* or legacy dp_*)",
    ),
  evidence: z.object({
    product_description: z.string().optional(),
    customer_communication: z.string().optional(),
    customer_email_address: z.string().email().optional(),
    customer_name: z.string().optional(),
    customer_purchase_ip: z.string().optional(),
    customer_signature: z.string().optional(),
    receipt: z.string().optional(),
    refund_policy: z.string().optional(),
    refund_policy_disclosure: z.string().optional(),
    refund_refusal_explanation: z.string().optional(),
    service_date: z.string().optional(),
    service_documentation: z.string().optional(),
    shipping_address: z.string().optional(),
    shipping_carrier: z.string().optional(),
    shipping_date: z.string().optional(),
    shipping_documentation: z.string().optional(),
    shipping_tracking_number: z.string().optional(),
    uncategorized_text: z.string().optional(),
  }),
  submit: z.boolean().default(false),
});

export const submitDisputeEvidenceTool: ToolSpec = {
  name: "stripe_submit_dispute_evidence",
  effect: "destructive",
  description:
    "Submit evidence to a Stripe dispute. WRITE TOOL — only callable by the decision dispatcher after operator approval. submit:true closes the dispute for further evidence (final answer); submit:false saves draft for later.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { dispute_id, evidence, submit } = inputSchema.parse(input);
    const stripe = await stripeClient(ctx.tenant_id);
    try {
      const updated = await stripe.disputes.update(dispute_id, {
        evidence,
        submit,
      });
      return {
        id: updated.id,
        status: updated.status,
        submitted_at: submit ? Math.floor(Date.now() / 1000) : null,
        evidence_due_by: updated.evidence_details?.due_by ?? null,
        submission_count: updated.evidence_details?.submission_count ?? 0,
      };
    } catch (e) {
      throw wrapStripeError(e);
    }
  },
};
