
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import {
  CreatorAreaError,
  loadCreatorOrder,
  resolveCreatorByAuthUser,
  type CreatorAreaMember,
} from "@/services/creators/creator-area";

const CLOSED_CREATOR_ORDER_ROUTES = new Set([
  "GET /api/creator/jobs/:orderId",
  "POST /api/creator/jobs/:orderId/upload-url",
  "POST /api/creator/jobs/:orderId/submissions",
]);

const CLOSED_CREATOR_ACCOUNT_ROUTES = new Set([
  "GET /api/creator/me",
  "GET /api/creator/jobs",
  "GET /api/creator/earnings",
  "GET /api/creator/reviews",
  "POST /api/creator/payouts/onboarding-link",
  "POST /api/creator/payouts/refresh",
  "POST /api/creator/payouts/tax-forms-link",
]);

const CLOSED_ORDER_STATUSES = new Set(["cancelled", "completed"]);

function routeKey(req: Request): string | null {
  const path = (req as { route?: { path?: unknown } }).route?.path;
  if (typeof path !== "string" || typeof req.method !== "string") return null;
  return `${req.method.toUpperCase()} ${req.baseUrl ?? ""}${path}`;
}

async function closedCreatorMayUse(req: Request, member: CreatorAreaMember): Promise<boolean> {
  const key = routeKey(req);
  if (!key) return false;
  if (CLOSED_CREATOR_ACCOUNT_ROUTES.has(key)) return true;
  if (!CLOSED_CREATOR_ORDER_ROUTES.has(key)) return false;
  const orderId = typeof req.params?.orderId === "string" ? req.params.orderId.trim() : "";
  if (!orderId) return false;
  const order = await loadCreatorOrder(member.id, orderId);
  return order != null && !CLOSED_ORDER_STATUSES.has(order.status);
}

export type CreatorPrincipal = {
  auth_user_id: string;
  email: string | null;
  member: CreatorAreaMember;
  member_id: string;
};

export function sendCreatorError(res: Response, e: unknown): void {
  if (e instanceof CreatorAreaError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  const code = (e as { code?: unknown })?.code;
  const message = (e as { message?: unknown })?.message;
  if (typeof code === "string" && typeof message === "string") {
    res.status(400).json({ error: { code, message } });
    return;
  }
  console.error(`[creator] unexpected: ${(e as Error)?.message ?? String(e)}`);
  res.status(500).json({
    error: { code: "creator_unavailable", message: "Something went wrong. Try again." },
  });
}

export async function requireCreator(
  req: Request,
  res: Response,
): Promise<CreatorPrincipal | null> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return null;
  }

  let member: CreatorAreaMember | null;
  try {
    member = await resolveCreatorByAuthUser(verified.user_id);
  } catch (e) {
    sendCreatorError(res, e);
    return null;
  }

  if (!member) {
    res.status(403).json({
      error: {
        code: "not_a_creator",
        message: "This area is for Zavi creators. Your account is not a creator account.",
      },
    });
    return null;
  }

  let closedButAllowed = false;
  if (member.vetting_state === "rejected") {
    try {
      closedButAllowed = await closedCreatorMayUse(req, member);
    } catch (e) {
      sendCreatorError(res, e);
      return null;
    }
  }

  if (member.vetting_state === "rejected" && !closedButAllowed) {
    res.status(403).json({
      error: {
        code: "not_approved",
        message: "Your creator account is closed. Email support if you think that is wrong.",
      },
      vetting_state: member.vetting_state,
    });
    return null;
  }

  return { auth_user_id: verified.user_id, email: verified.email ?? null, member, member_id: member.id };
}
