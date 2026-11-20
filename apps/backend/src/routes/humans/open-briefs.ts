
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import {
  applyToBrief,
  creatorBoard,
  myApplication,
  realBoardDeps,
} from "@/services/creators/brief-applications";
import {
  answerByCopy,
  briefSpotsLine,
  creatorVisibleBrief,
} from "@/services/creators/brief-projection";
import {
  countBriefApplications,
  insertBriefApplication,
  closeTenantBrief,
  loadBoardBrief,
  loadBoardMemberByAuthUser,
  resolveBriefTenant,
  resolveBusinessName,
  type BoardMemberRow,
} from "@/services/creators/briefs-db";
import { notify } from "@/services/creators/notify";
import { quoteFeeSplit } from "@/services/creators/briefs";

const IdParam = z.object({ id: z.string().uuid() });

const ApplyBody = z.object({
  quoted_rate_usd: z.union([z.number(), z.string()]),
  note: z.string().max(4000).nullable().optional(),
});

type Creator = { auth_user_id: string; member: BoardMemberRow };

async function requireCreator(req: Request, res: Response): Promise<Creator | null> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return null;
  }
  const member = await loadBoardMemberByAuthUser(verified.user_id);
  if (!member) {
    res
      .status(403)
      .json({ error: { code: "not_a_creator", message: "This account is not a Zavi creator." } });
    return null;
  }
  if (member.vetting_state !== "approved") {
    res.status(403).json({
      error: { code: "not_approved", message: "Your creator profile is not approved yet." },
    });
    return null;
  }
  return { auth_user_id: verified.user_id, member };
}

function unavailable(res: Response, e: unknown): void {
  console.error(`[open-briefs] unexpected failure: ${(e as Error)?.message ?? e}`);
  res.status(500).json({
    error: { code: "briefs_unavailable", message: "Open briefs are temporarily unavailable." },
  });
}

export async function getOpenBriefs(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  try {
    const board = await creatorBoard({ member: me.member }, realBoardDeps);
    res.json(board);
  } catch (e) {
    unavailable(res, e);
  }
}

export async function getOpenBrief(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_id", message: "A brief id is required." } });
    return;
  }
  try {
    const row = await loadBoardBrief(parsed.data.id);
    const ref = row ? await resolveBriefTenant(parsed.data.id) : null;
    if (!row || !ref) {
      res.status(404).json({ error: { code: "brief_not_found", message: "That brief is not open." } });
      return;
    }
    const [business_name, applicant_count] = await Promise.all([
      resolveBusinessName(ref.tenant_id),
      countBriefApplications(ref.tenant_id, parsed.data.id),
    ]);
    const brief = creatorVisibleBrief(row, { business_name, applicant_count });
    const mine = await myApplication({
      tenant_id: ref.tenant_id,
      brief_id: parsed.data.id,
      human_member_id: me.member.id,
    });
    res.json({
      brief,
      spots_line: briefSpotsLine(brief),
      answer_by_line: answerByCopy(brief.answer_by).line,
      my_application: mine
        ? {
            application_id: mine.application.id,
            status: mine.application.status,
            note: (mine.application.pitch ?? "").trim(),
            quoted_rate_usd:
              mine.application.quoted_rate_usd === null
                ? null
                : Number(mine.application.quoted_rate_usd),
            fees: mine.fees,
            applied_at: mine.application.created_at,
            hired_order_id: mine.hired_order_id,
            hired_order_status: mine.hired_order_status,
            business_note: mine.business_note,
          }
        : null,
    });
  } catch (e) {
    unavailable(res, e);
  }
}

export async function getOpenBriefQuote(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const raw = req.query?.quoted_rate_usd;
  try {
    const fees = quoteFeeSplit(typeof raw === "string" ? raw : Number(raw));
    res.json({
      fees,
      explain: `You quote $${(fees.price_cents / 100).toFixed(2)}. Zavi keeps 15% of that, so you receive $${(fees.creator_payout_cents / 100).toFixed(2)}. The business pays $${(fees.business_total_cents / 100).toFixed(2)}, which includes Zavi's 10% on their side.`,
    });
  } catch {
    res
      .status(400)
      .json({ error: { code: "invalid_quote", message: "A quote has to be a dollar amount greater than zero." } });
  }
}

export async function postOpenBriefApply(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  const parsed = IdParam.safeParse({ id: req.params.briefId });
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_id", message: "A brief id is required." } });
    return;
  }
  const body = ApplyBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: { code: "validation", message: "Your own price is required to apply to a brief." },
    });
    return;
  }

  try {
    const result = await applyToBrief(
      {
        auth_user_id: me.auth_user_id,
        brief_id: parsed.data.id,
        quoted_rate_usd: body.data.quoted_rate_usd,
        note: body.data.note ?? null,
      },
      {
        loadMember: loadBoardMemberByAuthUser,
        loadBrief: loadBoardBrief,
        resolveTenant: resolveBriefTenant,
        count: countBriefApplications,
        insert: insertBriefApplication,
        businessName: resolveBusinessName,
        closeBrief: closeTenantBrief,
        notify,
      },
    );
    if (!result.ok) {
      const status =
        result.code === "brief_not_found"
          ? 404
          : result.code === "already_applied" || result.code === "cap_reached"
            ? 409
            : result.code === "not_a_creator" ||
                result.code === "not_approved" ||
                result.code === "affiliate_only" ||
                result.code === "payout_country_unsupported"
              ? 403
              : 400;
      res.status(status).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.status(201).json(result);
  } catch (e) {
    unavailable(res, e);
  }
}
