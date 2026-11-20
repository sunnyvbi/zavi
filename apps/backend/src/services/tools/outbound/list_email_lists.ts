
import { z } from "zod";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { readTestListKeys, testListKey } from "@/services/email-cards/variants";
import { listSummaries } from "@/services/comms/bulk-outbound/lists";
import { checkBulkSender } from "@/services/comms/bulk-outbound/readiness";

const inputSchema = z.object({});

type ListEmailListsResult = {
  lists: Array<{
    id: string;
    name: string;
    people: number;
    can_be_emailed: number;
    unsubscribed_or_bounced: number;
    ready_to_send: boolean;
    marked_test: boolean;
    not_ready_because: string | null;
    newer_import_waits?: string;
  }>;
  from_address: string | null;
  missing: string[];
};

type Deps = { checkSender?: typeof checkBulkSender; lists?: typeof listSummaries; testLists?: typeof readTestListKeys };

export function makeListEmailListsTool(deps: Deps = {}): ToolSpec<z.infer<typeof inputSchema>, ListEmailListsResult> {
  const checkSender = deps.checkSender ?? checkBulkSender;
  const readLists = deps.lists ?? listSummaries;
  const readMarks = deps.testLists ?? readTestListKeys;
  return {
    name: "outbound__list_email_lists",
    effect: "read",
    description:
      "List the founder's contact lists for bulk email: each list's name, how many people are on it, " +
      "how many can be emailed, whether it is ready to send, and marked_test: whether the founder marked it a test list (size never does). Also says what is still missing before " +
      "a bulk email can go out (a verified sending domain, a postal address, a confirmed list). Returns " +
      "names and counts only, never addresses. Call this before email__propose_campaign (route zavi_list).",
    input_schema: inputSchema,
    async execute(ctx: ToolContext): Promise<ListEmailListsResult> {
      const [sender, lists, marks] = await Promise.all([checkSender(ctx.tenant_id), readLists(ctx.tenant_id), readMarks(ctx.tenant_id).catch(() => null)]);
      if (!marks) throw new ExpectedToolError("email_test_lists_unreadable", "Zavi could not check the founder's test lists, so it cannot say which lists are marked. Try again.");
      const missing = sender.ok ? [] : [sender.sentence];
      if (lists.length === 0) {
        missing.push("There are no contact lists yet. Add one in Email campaigns settings: upload a CSV or import from your database.");
      }
      return {
        lists: lists.map((l) => {
          const ready = !!l.active && l.active.sendable > 0;
          const why = ready
            ? null
            : !l.active
              ? "Nobody has confirmed that the people on its latest import agreed to hear from the business."
              : "Everyone on it is unsubscribed or bounced.";
          return {
            id: l.id,
            name: l.name,
            people: l.active?.contact_count ?? l.latest?.contact_count ?? 0,
            can_be_emailed: l.active?.sendable ?? 0,
            unsubscribed_or_bounced: l.active?.unsubscribed_or_bounced ?? 0,
            ready_to_send: ready,
            marked_test: marks.has(testListKey("zavi_list", l.id)),
            not_ready_because: why,
            ...(l.active && l.needs_consent
              ? { newer_import_waits: "A newer import is waiting for consent. A planned email goes only to the people already confirmed. An email sent now is refused until the newer import is confirmed." }
              : {}),
          };
        }),
        from_address: sender.ok ? sender.sender.from_address : null,
        missing,
      };
    },
  };
}

export const listEmailListsTool = makeListEmailListsTool();
