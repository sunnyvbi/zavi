
import { z } from "zod";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";

const inputSchema = z.object({
  investor_id: z
    .string()
    .uuid()
    .describe("fundraising_investor.id for this target investor."),
  recipient: z
    .string()
    .email()
    .max(320)
    .describe(
      "The ENRICHED email address for this investor — must come from the Apify enrichment path, never fabricated by the model.",
    ),
  channel: z
    .literal("email")
    .default("email")
    .describe("Delivery channel. v1 email only."),
  subject: z.string().min(1).max(200).describe("Email subject line."),
  body_text: z
    .string()
    .min(1)
    .max(50_000)
    .describe("Full plain-text email body."),
  sender: z
    .string()
    .email()
    .optional()
    .describe(
      "Override From address. Omit to use tenant default or hello@zaviagent.com fallback.",
    ),
  strategy_run_id: z
    .string()
    .uuid()
    .optional()
    .describe("The agent_runs.id of the strategy run that produced this copy."),
});

type ProposeFundraisingEmailInput = z.infer<typeof inputSchema>;

type ProposeFundraisingEmailResult = {
  decision_id: string;
  decision_class: "fundraising.outbound.send";
  investor_id: string;
  recipient: string;
};

export const proposeFundraisingEmailTool: ToolSpec<
  ProposeFundraisingEmailInput,
  ProposeFundraisingEmailResult
> = {
  name: "fundraising__propose_email",
  effect: "write",
  description:
    "Propose sending ONE fundraising angel-round email to an investor whose email was verified by the enrichment path. Emits an approval-gated proposal — it never sends. The batch is authorized by the Run-angel-round click. Call ONLY after enrichInvestorEmail returns a sendable result; never fabricate the recipient.",
  input_schema: inputSchema,
  async execute(
    ctx: ToolContext,
    input: ProposeFundraisingEmailInput,
  ): Promise<ProposeFundraisingEmailResult> {
    if (!ctx.emit_decision) {
      throw new ExpectedToolError(
        "emit_unavailable",
        "Cannot propose a fundraising email outside a managed agent run.",
      );
    }
    const body = {
      investor_id: input.investor_id,
      recipient: input.recipient,
      channel: "email" as const,
      subject: input.subject,
      body_text: input.body_text,
      ...(input.sender ? { sender: input.sender } : {}),
      ...(input.strategy_run_id ? { strategy_run_id: input.strategy_run_id } : {}),
    };
    const decision_id = await ctx.emit_decision("fundraising.outbound.send", body);
    return {
      decision_id,
      decision_class: "fundraising.outbound.send",
      investor_id: input.investor_id,
      recipient: input.recipient,
    };
  },
};
