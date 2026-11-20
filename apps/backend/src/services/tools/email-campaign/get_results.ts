
import { z } from "zod";
import { CARRIED_WHY, listSentEmails, type Cell } from "@/services/email-results/view";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

const MAX_EMAILS = 10;

const v = (c: Cell): number | null => c.value;

export const emailCampaignGetResultsTool: ToolSpec = {
  name: "email_campaign_get_results",
  effect: "read",
  description:
    "How the last emails Zavi sent did, on every route (SendGrid, Mailchimp, Klaviyo or Zavi's own sender): people sent to, delivered, " +
    "opens, clicks, unsubscribes and website visitors from the email's tag, `as_of` the 1-hour check or the day-7 result, with the " +
    "win line set at send and whether day 7 beat it. Read-only. A number that was not reported is null with a reason, never zero. " +
    "`from_1_hour` names numbers day 7 could not read; never call those day-7 results. " +
    "Opens on Zavi's own sender count every open; judge emails on visitors or clicks, not opens.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const rows = await listSentEmails(ctx.tenant_id, MAX_EMAILS);
    const emails = rows.slice(0, MAX_EMAILS).map((r) => ({
      sent_with: r.sent_with,
      subject: r.subject,
      list: r.list_name,
      sent_at: r.finished_at ?? r.started_at,
      status: r.stop_note ?? (r.stage === "sending" || r.stage === "paused" ? r.verdict_text : null),
      as_of: r.stopped_at_1_hour ? "h1" : r.as_of,
      people: r.people.sent,
      stopped_after: r.people.stopped ? `${r.people.sent} of ${r.people.total}` : null,
      delivered: v(r.delivered),
      ...(r.route === "mailchimp" ? { delivered_means: "Sent and did not bounce. Mailchimp cannot see whether it reached the inbox or went to spam; do not say it arrived." } : {}),
      opens: v(r.opens),
      clicks: v(r.clicks),
      unsubscribes: v(r.unsubscribes),
      visitors: v(r.visitors),
      missing: Object.fromEntries(
        (["delivered", "opens", "clicks", "unsubscribes", "visitors"] as const).filter((k) => r[k].value === null && r[k].why).map((k) => [k, r[k].why]),
      ),
      win_line: r.win_line.text,
      from_1_hour: r.numbers_note ? (["delivered", "opens", "clicks", "unsubscribes"] as const).filter((k) => r[k].value !== null && r[k].why?.startsWith(CARRIED_WHY)) : [],
      day_7: r.as_of === "d7" ? r.verdict_text : r.d7_due_at ? `due ${r.d7_due_at.slice(0, 10)}` : null,
      note: r.numbers_note ?? r.note,
    }));
    return { count: emails.length, emails };
  },
};
