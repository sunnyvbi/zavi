
import { z } from "zod";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { planRefusal, SKIP_REASONS } from "@/services/email-plan/messages";
import { planEmail, PLAN_ROUTES, type PlanDeps } from "@/services/email-plan/plan";
import { wallLabel } from "@/services/email-plan/time";

export type RunContext = { found: boolean; mode: "weekly_plan" | "planned_draft" | null; briefed?: boolean };

export type PlanToolDeps = {
  runContext: (tenantId: string, runId: string) => Promise<RunContext>;
  plan: Partial<PlanDeps>;
  list: (tenantId: string) => Promise<{ ok: boolean; items?: PlanItem[]; next_plan_at?: string | null }>;
};

export type PlanItem = {
  id: string;
  route: string;
  list_id: string;
  list_name: string;
  planned_at: string;
  timezone: string;
  angle: string;
  why: string | null;
  source: string;
  status: string;
  status_reason: string | null;
  card: { rail: string; id: string } | null;
};

async function rpc<T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

const LIVE: PlanToolDeps = {
  runContext: (tenantId, runId) => rpc<RunContext>(tenantId, "email_plan_run_context", { p_run_id: runId }),
  plan: {},
  list: (tenantId) => rpc(tenantId, "list_email_planned_sends", { p_user_id: null }),
};

const planSchema = z.object({
  route: z.enum(PLAN_ROUTES).describe("Where it goes out: the founder's sendgrid, mailchimp or klaviyo, or zavi_list."),
  audience_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "audience_id must be a bare list id")
    .optional()
    .describe("SendGrid, Mailchimp or Klaviyo: the list id from email_campaign__list_audiences."),
  list_id: z.string().uuid().optional().describe("zavi_list: the list id from outbound__list_email_lists."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The day, on the workspace's clock: YYYY-MM-DD, 26 hours to 14 days ahead."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("The time on the workspace's clock, 24-hour HH:MM."),
  angle: z.string().min(3).max(120).describe("What this email is about, in one line."),
  why: z.string().min(10).max(300).describe("Why this list, this angle, this day: cite a result or a lesson."),
});
type PlanArgs = z.infer<typeof planSchema>;

async function contextOf(ctx: ToolContext, deps: PlanToolDeps): Promise<RunContext> {
  if (!ctx.run_id) return { found: false, mode: null };
  try {
    return await deps.runContext(ctx.tenant_id, ctx.run_id);
  } catch {
    throw new ExpectedToolError("plan_unreadable", planRefusal("plan_unreadable"));
  }
}

export function makePlanSendTool(depsIn: Partial<PlanToolDeps> = {}): ToolSpec<PlanArgs, Record<string, unknown>> {
  const deps = { ...LIVE, ...depsIn };
  return {
    name: "email_plan_send",
    effect: "write",
    description:
      "Add ONE email to the workspace's plan (Coming up): a list, a day and time on the workspace's clock, an angle and why. " +
      "Files no card and sends nothing: Zavi drafts it the day before, and it goes at that time only if an owner or admin approved it " +
      "for that time, or Auto send allows it. Refuses a time under 26 hours or over 14 days ahead, a 4th email in one week, a second " +
      "email to one list within 7 days, a marked test list, and a list that cannot be emailed. Read email__list_plan first.",
    input_schema: planSchema,
    async execute(ctx, input) {
      const args = planSchema.parse(input);
      if (ctx.writes_suppressed) throw new ExpectedToolError("plan_writes_suppressed", planRefusal("plan_writes_suppressed"));
      const run = await contextOf(ctx, deps);
      if (run.mode === "planned_draft") throw new ExpectedToolError("plan_run_drafts_only", planRefusal("plan_run_drafts_only"));
      const listId = args.route === "zavi_list" ? args.list_id : args.audience_id;
      if (!listId || (args.route === "zavi_list" ? !!args.audience_id : !!args.list_id)) {
        throw new ExpectedToolError(
          "email_list_required",
          "Name the list: audience_id for SendGrid, Mailchimp or Klaviyo, list_id for a Zavi list (not both).",
        );
      }
      const out = await planEmail(
        ctx.tenant_id,
        {
          route: args.route,
          list_id: listId,
          date: args.date,
          time: args.time,
          angle: args.angle.trim(),
          why: args.why.trim(),
          source: run.briefed ? "growth_agent" : "email_agent",
          actor: null,
          request_key: `run:${ctx.run_id ?? "none"}:${args.route}:${listId}:${args.date}`,
        },
        deps.plan,
      );
      if (!out.ok) throw new ExpectedToolError(`email_plan_${out.code}`, out.sentence ?? planRefusal(out.code));
      return {
        planned: { id: out.id, list: out.list_name, when: `${out.label} (${out.timezone})`, angle: args.angle.trim() },
        replayed: out.replayed,
        note: "Planned. Nothing is drafted or sent yet: Zavi drafts it the day before, and it goes at that time only with an approval or Auto send. Tell the founder it is planned, not sent.",
      };
    },
  };
}

const listSchema = z.object({});

export function makeListPlanTool(depsIn: Partial<PlanToolDeps> = {}): ToolSpec<z.infer<typeof listSchema>, Record<string, unknown>> {
  const deps = { ...LIVE, ...depsIn };
  return {
    name: "email_list_plan",
    effect: "read",
    description:
      "The workspace's email plan (Coming up): every email planned in the next 14 days and what happened to the ones of the last 7 " +
      "(planned, drafting, ready, approved for its time, sending, sent, skipped and why), with the list and the time on the workspace's clock.",
    input_schema: listSchema,
    async execute(ctx) {
      const out = await deps.list(ctx.tenant_id).catch(() => null);
      if (!out?.ok) throw new ExpectedToolError("plan_unreadable", planRefusal("plan_unreadable"));
      const items = (out.items ?? []).map((i) => ({
        id: i.id,
        list: i.list_name,
        route: i.route,
        list_id: i.list_id,
        when: wallLabel(i.planned_at, i.timezone),
        angle: i.angle,
        why: i.why,
        by: i.source === "founder" ? "the founder" : i.source === "growth_agent" ? "the Growth agent" : "the email agent",
        status: i.status,
        ...(i.status_reason ? { reason: SKIP_REASONS[i.status_reason] ?? i.status_reason } : {}),
      }));
      return {
        items,
        rules: "At most 3 a week, 1 per list per 7 days, 26 hours to 14 days ahead.",
        next_plan_at: out.next_plan_at ?? null,
      };
    },
  };
}

export const emailPlanSendTool = makePlanSendTool();
export const emailListPlanTool = makeListPlanTool();
