
import { z } from "zod";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { BULK_COHORT_HARD_CAP, resolveCohort, type CohortSource } from "@/services/comms/bulk-outbound/cohort";
import { makeListCohortSource } from "@/services/comms/bulk-outbound/list-source";
import { listSummaries, type ListSummary } from "@/services/comms/bulk-outbound/lists";
import { checkBulkSender } from "@/services/comms/bulk-outbound/readiness";
import { resolveBulkReplyTo } from "@/services/comms/bulk-outbound/reply-to";
import { maskAddress } from "@/services/comms/bulk-outbound/mask";
import { oneLineField } from "@/services/email-cards/variants";

const inputSchema = z.object({
  list_name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("The name of one of the founder's contact lists, exactly as they named it."),
  list_id: z.string().uuid().optional().describe("The list's id, if you have it. Use this or list_name."),
  selector: z
    .object({ segment: z.string().min(1).max(120) })
    .optional()
    .describe("Older way to name the list. Prefer list_name."),
  subject: oneLineField("subject", 1, 200).describe("Email subject line. The same for every person on the list."),
  body_text: z
    .string()
    .min(1)
    .max(50_000)
    .describe(
      "The plain-text email body. One shared body for the whole list; there are no per-person merge " +
        "fields. Plain text only: this exact text is what each person receives (Zavi formats it as the " +
        "email). Do not write an unsubscribe line or a postal address: Zavi adds both to every email.",
    ),
});

type ProposeCohortEmailInput = z.infer<typeof inputSchema>;

type ProposeCohortEmailResult = {
  decision_id: string;
  decision_class: "bulk_outbound.send";
  list_name: string;
  est_recipient_count: number;
  will_be_skipped: number;
  from_address: string;
  sends_on_approval: true;
  note: string;
};

export function bulkProposedNote(count: number, listName: string, from: string): string {
  return (
    `Proposed for approval. Nothing has been sent. If a workspace member approves, Zavi sends this email ` +
    `to the ${count} ${count === 1 ? "person" : "people"} on "${listName}" from ${from}, one email per person, ` +
    `each with an unsubscribe link and the business postal address. Tell the founder it is waiting for ` +
    `their approval. Do not say it was sent.`
  );
}

type ProposeCohortDeps = {
  source?: (list: { listId: string; versionId: string }) => CohortSource;
  checkSender?: typeof checkBulkSender;
  lists?: typeof listSummaries;
  replyTo?: (tenantId: string) => Promise<string | null>;
};

function listNames(lists: ListSummary[]): string {
  if (lists.length === 0) {
    return (
      "This workspace has no contact lists yet. The founder adds one in Email campaigns settings, by " +
      "uploading a CSV or importing from their connected database."
    );
  }
  return `Lists in this workspace: ${lists.map((l) => `"${l.name}"`).join(", ")}.`;
}

export function makeProposeCohortEmailTool(
  deps: ProposeCohortDeps = {},
): ToolSpec<ProposeCohortEmailInput, ProposeCohortEmailResult> {
  const sourceFor = deps.source ?? makeListCohortSource;
  const checkSender = deps.checkSender ?? checkBulkSender;
  const readLists = deps.lists ?? listSummaries;
  const replyToFor = deps.replyTo ?? resolveBulkReplyTo;
  return {
    name: "outbound__propose_cohort_email",
    effect: "write",
    description:
      "Propose ONE bulk email to one of the founder's own contact lists. You give the list's name and " +
      "the subject and body; Zavi reads the people from that list on the server. This emits one " +
      "approval card and sends nothing by itself. When a workspace member approves the card, Zavi SENDS " +
      "the email to everyone on the list from the founder's own verified domain, one email per person, " +
      "with an unsubscribe link and the business postal address added to each, skipping anyone who " +
      "unsubscribed or bounced. You can never supply or invent recipients, and a list can only be " +
      "emailed after the founder confirmed those people agreed to hear from them. If this tool refuses, " +
      "tell the founder the reason it gives, in its words. At most 1,000 people per send.",
    input_schema: inputSchema,
    async execute(ctx: ToolContext, input: ProposeCohortEmailInput): Promise<ProposeCohortEmailResult> {
      if (!ctx.emit_decision) {
        throw new ExpectedToolError("emit_unavailable", "Cannot propose a bulk email outside a managed agent run.");
      }

      const sender = await checkSender(ctx.tenant_id);
      if (!sender.ok) {
        throw new ExpectedToolError(
          sender.code,
          sender.code === "bulk_outbound_disabled"
            ? `${sender.sentence} Draft the message in your reply for the founder to send from their own email tool.`
            : `${sender.sentence} Nothing was proposed.`,
        );
      }

      const wanted = (input.list_name ?? input.selector?.segment ?? "").trim().toLowerCase();
      if (!input.list_id && !wanted) {
        throw new ExpectedToolError("list_not_found", "Name the contact list to send to.");
      }
      const lists = await readLists(ctx.tenant_id);
      const list = input.list_id
        ? lists.find((l) => l.id === input.list_id)
        : lists.find((l) => l.name.trim().toLowerCase() === wanted);
      if (!list) {
        throw new ExpectedToolError("list_not_found", `No contact list with that name. ${listNames(lists)}`);
      }
      if (!list.active || list.needs_consent) {
        throw new ExpectedToolError(
          "list_not_consented",
          `The list "${list.name}" cannot be emailed yet: nobody has confirmed that the people on its ` +
            `latest import agreed to hear from the business. The founder confirms that in Email campaigns settings.`,
        );
      }
      if (list.active.sendable === 0) {
        throw new ExpectedToolError(
          "list_empty",
          `There is nobody on "${list.name}" who can be emailed. Do not invent recipients.`,
        );
      }

      const cohort = await resolveCohort(
        ctx.tenant_id,
        { segment: list.name },
        "opt_in",
        sourceFor({ listId: list.id, versionId: list.active.id }),
      );
      if (cohort.est_recipient_count === 0) {
        throw new ExpectedToolError(
          "list_empty",
          `There is nobody on "${list.name}" who can be emailed. Do not invent recipients.`,
        );
      }

      const replyTo = await replyToFor(ctx.tenant_id).catch(() => {
        throw new ExpectedToolError("bulk_check_failed", "Zavi could not check where replies to this email go, so nothing was proposed. Try again in a minute.");
      });
      const body = {
        list_id: list.id,
        list_version_id: list.active.id,
        list_name: list.name,
        from_address: sender.sender.from_address,
        reply_to: replyTo,
        template: {
          subject: input.subject,
          body_text: input.body_text,
        },
        est_recipient_count: cohort.est_recipient_count,
        list_source: list.active.source_kind,
        sample_recipients:
          list.active.source_kind === "database"
            ? cohort.sample_recipients.map((e) => maskAddress(e) ?? "•••")
            : cohort.sample_recipients,
        ...(list.active.unsubscribed_or_bounced > 0 ? { will_be_skipped: list.active.unsubscribed_or_bounced } : {}),
        ...(cohort.capped ? { capped_at: BULK_COHORT_HARD_CAP } : {}),
      };

      const decision_id = await ctx.emit_decision("bulk_outbound.send", body);
      return {
        decision_id,
        decision_class: "bulk_outbound.send",
        list_name: list.name,
        est_recipient_count: cohort.est_recipient_count,
        will_be_skipped: list.active.unsubscribed_or_bounced,
        from_address: sender.sender.from_address,
        sends_on_approval: true,
        note: bulkProposedNote(cohort.est_recipient_count, list.name, sender.sender.from_address),
      };
    },
  };
}

export const proposeCohortEmailTool = makeProposeCohortEmailTool();
