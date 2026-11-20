
import { z } from "zod";
import type { GovernedToolKey } from "./governance-verdict";
import {
  createIssueInput as jiraCreateInput,
  addCommentInput as jiraCommentInput,
} from "./internal/jira";
import {
  createIssueInput as linearCreateInput,
  addCommentInput as linearCommentInput,
} from "./internal/linear";
import { openPrInput, pushToMainInput, squashMergeInput } from "./internal/github";
import { prProposalSchema, prProposalProductBuildSchema } from "@/agents/engineer/output-schema";
import { createPaymentTool } from "@/services/tools/stripe/create_payment";
import { remitToTenantTool } from "@/services/tools/stripe/remit_to_tenant";
import { submitDisputeEvidenceTool } from "@/services/tools/stripe/submit_dispute_evidence";
import { findHeldFundByRef } from "@/services/tools/stripe/held-funds";

export type CardBuild =
  | {
      ok: true;
      body: Record<string, unknown>;
      decision_class?: string;
    }
  | { ok: false; reason: string };

export type CardCtx = { tenant_id: string };

export type ApprovalCardSpec =
  | { kind: "typed"; build: (args: unknown, ctx: CardCtx) => CardBuild | Promise<CardBuild> }
  | { kind: "refuse"; reason: string };

function refuse(what: string, instead: string): ApprovalCardSpec {
  return {
    kind: "refuse",
    reason:
      `${what} cannot be sent for approval as a direct tool call yet (it has no card that shows the founder the exact action). ` +
      `${instead}`,
  };
}

function issuesOf(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

function typedFrom(schema: z.ZodTypeAny, what: string): ApprovalCardSpec {
  return {
    kind: "typed",
    build(args: unknown): CardBuild {
      const p = schema.safeParse(args);
      if (!p.success) return { ok: false, reason: `${what} is not complete: ${issuesOf(p.error)}` };
      return { ok: true, body: { ...(p.data as Record<string, unknown>) } };
    },
  };
}

export const EMAIL_CARD_MAX_CHARS = 2_400;
const emailArgs = z.object({
  to: z.string().email("to must be a valid email address"),
  subject: z.string().min(1).max(200),
  body_text: z
    .string()
    .min(1)
    .max(EMAIL_CARD_MAX_CHARS, `the message must be at most ${EMAIL_CARD_MAX_CHARS} characters so the founder can read all of it before approving`),
  reply_to: z.string().email().optional(),
});

const DISPUTE_SENDABLE_FIELDS = [
  "customer_communication",
  "customer_purchase_ip",
  "service_documentation",
  "receipt",
  "shipping_documentation",
  "uncategorized_text",
] as const;
const DISPUTE_FIELD_MAX = 20_000;

const TELL_FOUNDER = "Tell the founder what you wanted to do and why, so they can do it or ask for it.";

function prCard(args: unknown, push: boolean): CardBuild {
  const raw = (push ? pushToMainInput : openPrInput).safeParse(args);
  if (!raw.success) return { ok: false, reason: `The change is not complete: ${issuesOf(raw.error)}` };
  const r = raw.data as {
    owner: string;
    repo: string;
    base_branch: string;
    head_branch?: string;
    title: string;
    body?: string;
    files: unknown[];
  };
  const proposal = {
    repo: `${r.owner}/${r.repo}`,
    base_branch: r.base_branch,
    head_branch: r.head_branch ?? `engineer/direct-${Date.now().toString(36)}`,
    title: r.title,
    body: r.body ?? "",
    files: r.files,
    ...(push ? { push_to_main: true } : {}),
  };
  const p = (push ? prProposalProductBuildSchema : prProposalSchema).safeParse(proposal);
  if (!p.success) return { ok: false, reason: `The change cannot be proposed: ${issuesOf(p.error)}` };
  return { ok: true, body: { ...(p.data as Record<string, unknown>) } };
}

export const APPROVAL_CARDS = {
  email__send: {
    kind: "typed",
    build(args: unknown): CardBuild {
      const p = emailArgs.safeParse(args);
      if (!p.success) return { ok: false, reason: `The email is not complete: ${issuesOf(p.error)}` };
      return { ok: true, body: { ...p.data } };
    },
  },
  slack__post_message: refuse("A Slack message", TELL_FOUNDER),
  slack__open_dm: refuse("A Slack direct message", TELL_FOUNDER),
  slack__upload_file: refuse("A Slack file upload", TELL_FOUNDER),

  jira__create_issue: typedFrom(jiraCreateInput, "The Jira issue"),
  jira__add_comment: typedFrom(jiraCommentInput, "The Jira comment"),
  linear__create_issue: typedFrom(linearCreateInput, "The Linear issue"),
  linear__add_comment: typedFrom(linearCommentInput, "The Linear comment"),

  github__open_pr: { kind: "typed", build: (args: unknown) => prCard(args, false) },
  github__push_to_main: { kind: "typed", build: (args: unknown) => prCard(args, true) },
  github__squash_merge: typedFrom(squashMergeInput, "The merge"),

  stripe__create_payment: {
    kind: "typed",
    build(args: unknown): CardBuild {
      const p = createPaymentTool.input_schema.safeParse(args);
      if (!p.success) return { ok: false, reason: `The charge is not complete: ${issuesOf(p.error)}` };
      const d = p.data as { amount: number; application_fee_amount: number };
      if (d.application_fee_amount >= d.amount) {
        return { ok: false, reason: "The charge is not complete: Zavi's fee must be less than the amount." };
      }
      return { ok: true, body: { ...(p.data as Record<string, unknown>) } };
    },
  },
  stripe__remit_to_tenant: {
    kind: "typed",
    async build(args: unknown, ctx: CardCtx): Promise<CardBuild> {
      const p = remitToTenantTool.input_schema.safeParse(args);
      if (!p.success) return { ok: false, reason: `The payout is not complete: ${issuesOf(p.error)}` };
      const { client_reference, description } = p.data as { client_reference: string; description?: string };
      let row;
      try {
        row = await findHeldFundByRef(ctx.tenant_id, client_reference);
      } catch {
        return { ok: false, reason: "Could not read the held collection for this payout, so it was not queued. Try again." };
      }
      if (!row || row.status !== "held") {
        return {
          ok: false,
          reason: `There is no held collection ready to pay out for '${client_reference}'${row ? ` (it is ${row.status})` : ""}.`,
        };
      }
      const net = row.amount_minor - row.reserve_held_minor - row.platform_fee_minor;
      if (row.reserve_held_minor < 0 || row.platform_fee_minor < 0 || net <= 0) {
        return { ok: false, reason: `The held collection for '${client_reference}' has nothing to pay out.` };
      }
      return {
        ok: true,
        body: {
          client_reference,
          description: description ?? null,
          held_fund_id: row.id,
          currency: row.currency,
          gross_minor: row.amount_minor,
          reserve_minor: row.reserve_held_minor,
          fee_minor: row.platform_fee_minor,
          net_minor: net,
        },
      };
    },
  },
  stripe__submit_dispute_evidence: {
    kind: "typed",
    build(args: unknown): CardBuild {
      const p = submitDisputeEvidenceTool.input_schema.safeParse(args);
      if (!p.success) return { ok: false, reason: `The dispute evidence is not complete: ${issuesOf(p.error)}` };
      const { dispute_id, evidence, submit } = p.data as {
        dispute_id: string;
        evidence?: Record<string, unknown>;
        submit?: boolean;
      };
      const given = Object.entries(evidence ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== "");
      const unsendable = given.map(([k]) => k).filter((k) => !(DISPUTE_SENDABLE_FIELDS as readonly string[]).includes(k));
      if (unsendable.length) {
        return {
          ok: false,
          reason:
            `These evidence fields cannot be sent from a direct call: ${unsendable.join(", ")}. ` +
            `Only ${DISPUTE_SENDABLE_FIELDS.join(", ")} can be sent (customer name, email and address never are).`,
        };
      }
      if (!given.length) return { ok: false, reason: "The dispute evidence is empty." };
      const tooLong = given.find(([, v]) => (v as string).length > DISPUTE_FIELD_MAX);
      if (tooLong) return { ok: false, reason: `The evidence field ${tooLong[0]} is longer than ${DISPUTE_FIELD_MAX} characters.` };
      return {
        ok: true,
        ...(submit === true ? { decision_class: "dispute-response.final-submit-evidence" } : {}),
        body: {
          evidence_packet: { dispute_id, evidence_fields: Object.fromEntries(given) },
          submit_final: submit === true,
        },
      };
    },
  },
  stripe__create_connected_account: typedFrom(
    z.object({ company_name: z.string().trim().min(1).max(100) }),
    "The Stripe account setup",
  ),
} satisfies Record<GovernedToolKey, ApprovalCardSpec>;

export function approvalCardFor(server_id: string, tool_name: string): ApprovalCardSpec | null {
  const key = `${server_id}__${tool_name}`;
  return (APPROVAL_CARDS as Record<string, ApprovalCardSpec>)[key] ?? null;
}
