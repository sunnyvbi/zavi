
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { resolveAuthRedirectBase } from "@/services/auth/redirect-base";
import {
  briefWorkbench,
  listApplicantsForBusiness,
  publishBrief,
  repostBrief,
  saveBrief,
} from "@/services/creators/briefs";
import {
  realAutoNoDeps,
  sendAutomaticNos,
  sendBriefFitAlerts,
} from "@/services/creators/brief-applications";
import {
  hireApplicant,
  realHireDeps,
  settleBriefHire,
} from "@/services/creators/brief-hire";
import {
  insertTenantBrief,
  listCreatorsMatchingBriefFilters,
  loadTenantBrief,
  resolveBusinessName,
} from "@/services/creators/briefs-db";
import { notify } from "@/services/creators/notify";
import { applicantHireCancelPath, businessJobReturnPaths } from "@/services/creators/hub-links";
import { armBriefAnswerBy } from "../../../workers/functions/creator-brief-answer-by";

const IdParam = z.object({ id: z.string().uuid() });

function badId(res: Response, what: string): void {
  res.status(400).json({ error: { code: "bad_id", message: `A ${what} id is required.` } });
}

function sendBriefError(res: Response, e: unknown): void {
  if (e instanceof ExpectedToolError) {
    const status =
      e.code === "brief_not_found" ? 404 : e.code === "brief_locked" || e.code === "brief_not_posted" ? 409 : 400;
    res.status(status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[creator-briefs] unexpected failure: ${(e as Error)?.message ?? e}`);
  res
    .status(500)
    .json({ error: { code: "briefs_unavailable", message: "Briefs are temporarily unavailable." } });
}

function webOrigin(): string {
  return resolveAuthRedirectBase() ?? process.env.PRAXIS_WEB_ORIGIN ?? "https://www.zaviagent.com";
}

export async function postHumanBrief(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const brief = await saveBrief({
      tenant_id: auth.tenant_id,
      input: body,
      blank: body.blank === true,
    });
    res.status(201).json({ brief });
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function patchHumanBrief(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  try {
    await saveBrief({
      tenant_id: auth.tenant_id,
      brief_id: parsed.data.id,
      input: (req.body ?? {}) as Record<string, unknown>,
    });
    const bench = await briefWorkbench({ tenant_id: auth.tenant_id, brief_id: parsed.data.id });
    if (!bench) {
      res.status(404).json({ error: { code: "brief_not_found", message: "That brief does not exist." } });
      return;
    }
    res.json(bench);
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function getHumanBriefWorkbench(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  try {
    const bench = await briefWorkbench({ tenant_id: auth.tenant_id, brief_id: parsed.data.id });
    if (!bench) {
      res.status(404).json({ error: { code: "brief_not_found", message: "That brief does not exist." } });
      return;
    }
    res.json(bench);
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function postHumanBriefPublish(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  const body = (req.body ?? {}) as { answer_by?: string | null; applicant_cap?: number | null };

  try {
    const result = await publishBrief({
      tenant_id: auth.tenant_id,
      brief_id: parsed.data.id,
      answer_by: body.answer_by,
      ...(body.applicant_cap === undefined ? {} : { applicant_cap: body.applicant_cap }),
    });
    if (!result.ok) {
      res
        .status(result.code === "brief_not_found" ? 404 : 400)
        .json({ error: { code: result.code, message: result.message } });
      return;
    }

    let alerts = { matched: 0, alerted: 0 };
    if (result.first_publish) {
      try {
        await armBriefAnswerBy({
          brief_id: parsed.data.id,
          tenant_id: auth.tenant_id,
          answer_by: result.answer_by,
        });
      } catch (e) {
        await logEvent({
          level: "warn",
          source: "creator.briefs",
          code: "answer_by_arm_failed",
          message: (e as Error).message,
          tenant_id: auth.tenant_id,
          meta: { brief_id: parsed.data.id },
        });
      }
      try {
        alerts = await sendBriefFitAlerts(
          {
            tenant_id: auth.tenant_id,
            brief_id: parsed.data.id,
            brief_title: result.brief.title ?? "",
            lane: result.brief.lane ?? null,
            filters: (result.brief.filters ?? null) as {
              niches?: string[];
              platforms?: string[];
              locations?: string[];
            } | null,
          },
          {
            match: listCreatorsMatchingBriefFilters,
            businessName: resolveBusinessName,
            notify,
          },
        );
      } catch (e) {
        await logEvent({
          level: "warn",
          source: "creator.briefs",
          code: "fit_alerts_failed",
          message: (e as Error).message,
          tenant_id: auth.tenant_id,
          meta: { brief_id: parsed.data.id },
        });
      }
    }

    const bench = await briefWorkbench({ tenant_id: auth.tenant_id, brief_id: parsed.data.id });
    res.json({
      ...(bench ?? {}),
      first_publish: result.first_publish,
      answer_by: result.answer_by,
      applicant_cap: result.applicant_cap,
      fit_alerts: alerts,
    });
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function getHumanBriefApplicants(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  try {
    const [list, bench] = await Promise.all([
      listApplicantsForBusiness({ tenant_id: auth.tenant_id, brief_id: parsed.data.id }),
      briefWorkbench({ tenant_id: auth.tenant_id, brief_id: parsed.data.id }),
    ]);
    if (!list || !bench) {
      res.status(404).json({ error: { code: "brief_not_found", message: "That brief does not exist." } });
      return;
    }
    res.json({
      applicants: list.applicants,
      order: list.order,
      brief: bench.creator_preview,
      applicant_count: bench.applicant_count,
      spots_line: bench.spots_line,
      answer_by_line: bench.answer_by_line,
      decline_note: bench.decline_note,
      decline_note_is_default: bench.decline_note_is_default,
    });
  } catch (e) {
    sendBriefError(res, e);
  }
}

const HireBody = z.object({
  application_id: z.string().uuid(),
  delivery_days: z.number().int().min(1).max(90).nullable().optional(),
  large_amount_confirmed: z.boolean().optional(),
});

export async function postHumanBriefHire(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  const body = HireBody.safeParse(req.body ?? {});
  if (!body.success) {
    res
      .status(400)
      .json({ error: { code: "validation", message: "An application id is required to hire." } });
    return;
  }

  const base = webOrigin();
  const back = businessJobReturnPaths("{ORDER_ID}");
  try {
    const result = await hireApplicant(
      {
        tenant_id: auth.tenant_id,
        brief_id: parsed.data.id,
        application_id: body.data.application_id,
        booked_by_user_id: auth.user_id ?? null,
        delivery_days: body.data.delivery_days ?? null,
        large_amount_confirmed: body.data.large_amount_confirmed,
        success_url: `${base}${back.success}`,
        cancel_url: `${base}${applicantHireCancelPath(parsed.data.id, body.data.application_id, "{ORDER_ID}")}`,
      },
      realHireDeps,
    );
    if (!result.ok) {
      const status = result.code === "brief_not_found" || result.code === "application_not_found" ? 404 : 400;
      res.status(status).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.json({
      order_id: result.order_id,
      application_id: result.application_id,
      due_at: result.due_at,
      fees: result.fees,
      checkout_url: result.checkout_url,
      checkout_session_id: result.checkout_session_id,
      what_happens_next:
        "Your card is held now. It is charged as soon as the hold is confirmed, the job starts straight away, and everyone else who applied gets your note.",
    });
  } catch (e) {
    sendBriefError(res, e);
  }
}

const SettleBody = z.object({
  order_id: z.string().uuid(),
  application_id: z.string().uuid(),
});

export async function postHumanBriefHireSettle(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  const body = SettleBody.safeParse(req.body ?? {});
  if (!body.success) {
    res
      .status(400)
      .json({ error: { code: "validation", message: "An order id and an application id are required." } });
    return;
  }
  try {
    const result = await settleBriefHire({
      tenant_id: auth.tenant_id,
      order_id: body.data.order_id,
      brief_id: parsed.data.id,
      application_id: body.data.application_id,
      actor_user_id: auth.user_id ?? null,
    });
    if (!result.ok) {
      res.status(409).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.json(result);
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function postHumanBriefRepost(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  try {
    const result = await repostBrief(
      { tenant_id: auth.tenant_id, brief_id: parsed.data.id },
      {
        load: loadTenantBrief,
        insert: insertTenantBrief,
        closeOld: ({ tenant_id, brief_id }) =>
          sendAutomaticNos({ tenant_id, brief_id, cause: "answer_by" }, realAutoNoDeps),
      },
    );
    const bench = await briefWorkbench({ tenant_id: auth.tenant_id, brief_id: result.brief.id });
    res.status(201).json({ ...(bench ?? { brief: result.brief }), closed_brief_id: result.closed_brief_id });
  } catch (e) {
    sendBriefError(res, e);
  }
}

export async function postHumanBriefClose(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) return badId(res, "brief");
  try {
    const result = await sendAutomaticNos(
      { tenant_id: auth.tenant_id, brief_id: parsed.data.id, cause: "answer_by" },
      realAutoNoDeps,
    );
    res.json({
      ...result,
      undo: false,
      undo_message:
        result.declined > 0
          ? `${result.declined} applicants have been told. Notes cannot be taken back.`
          : "Nobody was waiting on an answer, so no notes went out.",
    });
  } catch (e) {
    sendBriefError(res, e);
  }
}
