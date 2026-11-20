import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { asTenantId, readShopifyConfirmationUserEmail, tenantClient, type TenantId } from "@/services/tenant-client";
import { linkShopifyAppMember, shopifyAppMemberLinkAvailable, shopifyWorkspaceAdminRole } from "@/services/connectors/shopify/app-identity";
import { finishShopifyClaim } from "@/routes/connectors/shopify";
import { buildShopifyAppHome, oneClickApprovalAllowed } from "@/services/connectors/shopify/app-home";
import { resolveShopifyAppContext, ShopifyAppContextError } from "@/services/connectors/shopify/app-context";
import { startShopifySubscription, ShopifyBillingStartError } from "@/services/connectors/shopify/app-billing";
import { ShopifyGraphqlError } from "@/services/connectors/shopify/graphql";
import {
  signAppHomeInstallToken,
  signShopifyAppLinkToken,
  verifyShopifyAppHomeConfirmation,
  verifyShopifyAppLinkConfirmation,
  type ShopifyAppHomeConfirmation,
} from "@/services/connectors/shopify/hmac";
import { installLandingUrl } from "@/services/connectors/shopify/install-url";
import { getShopifyInstallStatus, storePendingShopifyInstall } from "@/services/connectors/shopify/pending-install";
import { exchangeShopifyOfflineToken, ShopifySessionError, verifyShopifyIdToken } from "@/services/connectors/shopify/session";
import { connectedTenantForShop } from "@/services/connectors/shopify/store";
import { readTenantDisabled } from "@/services/tenants/disabled";

declare module "express-serve-static-core" {
  interface Request {
    shopifyAppContext?: Awaited<ReturnType<typeof resolveShopifyAppContext>>;
  }
}

const DecisionBody = z.object({ decision: z.enum(["approve", "reject"]) });
const BillingBody = z.object({
  tier: z.enum(["starter", "growth", "pro"]),
  term: z.enum(["monthly", "annual"]),
});
const UUID = z.string().uuid();
const ConfirmationBody = z.object({ confirmation: z.string().min(1).max(4096) });

type ValidatedConfirmation = {
  session: Awaited<ReturnType<typeof verifyShopifyIdToken>>;
  install: ShopifyAppHomeConfirmation["ref"] | null;
  tenantId: TenantId;
  userId: string;
  role: string;
};

function authHeader(req: Request): string | undefined {
  return req.headers.authorization;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ShopifySessionError) {
    if (error.code === "stale_token") res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    res.status(401).json({
      error: {
        code: error.code,
        message: error.code === "reauthorization_required"
          ? "Shopify authorization needs to be renewed."
          : "Your Shopify session expired. Reload the app and try again.",
      },
    });
    return;
  }
  if (error instanceof ShopifyAppContextError) {
    const status = error.code === "shop_not_connected" ? 409 : 403;
    res.status(status).json({
      error: {
        code: error.code,
        message: error.code === "shop_not_connected"
          ? "This store is installed in Shopify but is not connected to a Zavi workspace yet. Finish connecting it in Zavi."
          : error.code === "user_not_linked"
            ? "Open Zavi from Shopify and connect this staff account to a workspace where you are an owner or admin."
          : "Zavi could not safely identify one workspace for this Shopify store.",
      },
    });
    return;
  }
  if (error instanceof ShopifyGraphqlError && error.code === "unauthorized") {
    res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    res.status(401).json({ error: { code: "stale_token", message: "Your Shopify session expired. Reload and try again." } });
    return;
  }
  res.status(502).json({ error: { code: "shopify_app_unavailable", message: "Zavi could not load this Shopify workspace. Try again." } });
}

export async function shopifyAppHome(req: Request, res: Response): Promise<void> {
  try {
    const context = await resolveShopifyAppContext(authHeader(req));
    res.set("Cache-Control", "private, no-store");
    res.json(await buildShopifyAppHome(context));
  } catch (error) {
    sendError(res, error);
  }
}

export async function shopifyAppHomeInstall(req: Request, res: Response): Promise<void> {
  try {
    const session = await verifyShopifyIdToken(authHeader(req));
    const connectedTenant = await connectedTenantForShop(session.shop);
    if (connectedTenant === "ambiguous") {
      res.status(409).json({ error: { code: "shop_ambiguous", message: "Zavi could not safely identify one workspace for this Shopify store." } });
      return;
    }
    if (connectedTenant) {
      res.set("Cache-Control", "private, no-store");
      res.json({ connect_url: installLandingUrl(signShopifyAppLinkToken(session.shop, session.shopify_user_id)) });
      return;
    }
    const grant = await exchangeShopifyOfflineToken(session);
    const pending = await storePendingShopifyInstall(session.shop, grant);
    const token = signAppHomeInstallToken(pending.installation_id, pending.generation, session.shopify_user_id);
    res.set("Cache-Control", "private, no-store");
    res.json({ connect_url: installLandingUrl(token) });
  } catch (error) {
    if (error instanceof ShopifySessionError) {
      sendError(res, error);
      return;
    }
    res.status(503).json({ error: { code: "shopify_install_unavailable", message: "Could not prepare this Shopify connection. Try again." } });
  }
}

async function validateInstallConfirmation(req: Request, res: Response): Promise<ValidatedConfirmation | null> {
  const body = ConfirmationBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_confirmation", message: "This Shopify confirmation is invalid. Start setup again." } });
    return null;
  }
  const session = await verifyShopifyIdToken(authHeader(req));
  const confirmation = verifyShopifyAppHomeConfirmation(body.data.confirmation);
  const link = confirmation ? null : verifyShopifyAppLinkConfirmation(body.data.confirmation);
  const target = confirmation ?? link;
  if (!target || (confirmation?.ref.shopify_user_id ?? link?.shopify_user_id) !== session.shopify_user_id) {
    res.status(403).json({ error: { code: "confirmation_mismatch", message: "This setup does not belong to the current Shopify staff session." } });
    return null;
  }
  const sameStore = confirmation
    ? (await getShopifyInstallStatus(confirmation.ref))?.shop === session.shop
    : link?.shop === session.shop && (await connectedTenantForShop(session.shop)) === target.tenant_id;
  if (!sameStore) {
    res.status(403).json({ error: { code: "confirmation_mismatch", message: "This setup does not belong to the current Shopify store." } });
    return null;
  }
  const tenantId = asTenantId(target.tenant_id);
  const disabled = await readTenantDisabled(target.tenant_id);
  if (disabled !== false) {
    res.status(disabled === true ? 403 : 503).json({ error: { code: disabled === true ? "workspace_disabled" : "workspace_unavailable", message: "This Zavi workspace is not available." } });
    return null;
  }
  const role = await shopifyWorkspaceAdminRole(target.tenant_id, target.user_id);
  if (!role) {
    res.status(403).json({ error: { code: "connector_admin_required", message: "Only a current Zavi workspace owner or admin can connect Shopify." } });
    return null;
  }
  return { session, install: confirmation?.ref ?? null, tenantId, userId: target.user_id, role };
}

export async function shopifyAppHomeInstallConfirmation(req: Request, res: Response): Promise<void> {
  try {
    const validated = await validateInstallConfirmation(req, res);
    if (!validated) return;
    const [{ data: workspace, error }, accountEmail] = await Promise.all([
      tenantClient(validated.tenantId).from("tenants").select("display_name").maybeSingle<{ display_name: string | null }>(),
      readShopifyConfirmationUserEmail(validated.userId),
    ]);
    if (error) throw error;
    res.set("Cache-Control", "private, no-store");
    res.json({
      shop: validated.session.shop,
      workspace: {
        display_name: workspace?.display_name?.trim() || "Your Zavi workspace",
        account_email: accountEmail,
        role: validated.role,
      },
      link_only: validated.install === null,
    });
  } catch (error) {
    if (error instanceof ShopifySessionError) {
      sendError(res, error);
      return;
    }
    res.status(503).json({ error: { code: "shopify_confirmation_unavailable", message: "Could not verify this Shopify connection. Start setup again." } });
  }
}

export async function shopifyAppHomeInstallConfirm(req: Request, res: Response): Promise<void> {
  try {
    const validated = await validateInstallConfirmation(req, res);
    if (!validated) return;
    if (!validated.install) {
      const identity = { tenant_id: validated.tenantId, shop: validated.session.shop, shopify_user_id: validated.session.shopify_user_id };
      if (!(await shopifyAppMemberLinkAvailable(identity))) {
        res.status(409).json({ error: { code: "shopify_identity_linked_elsewhere", message: "This Shopify staff account is linked to another active Zavi workspace for this store." } });
        return;
      }
      if (!(await linkShopifyAppMember({ ...identity, user_id: validated.userId }))) {
        res.status(409).json({ error: { code: "shopify_link_refused", message: "This Shopify staff account could not be linked. Open Zavi from Shopify and try again." } });
        return;
      }
      res.set("Cache-Control", "private, no-store");
      res.json({ ok: true, linked: true });
      return;
    }
    await finishShopifyClaim(validated.install, {
      tenant_id: validated.tenantId,
      user_id: validated.userId,
      email: null,
    }, res);
  } catch (error) {
    if (error instanceof ShopifySessionError) {
      sendError(res, error);
      return;
    }
    res.status(503).json({ error: { code: "shopify_confirmation_unavailable", message: "Could not confirm this Shopify connection. Try setup again." } });
  }
}

export async function shopifyAppHomeDecide(req: Request, res: Response): Promise<void> {
  const decisionId = UUID.safeParse(req.params.decision_id);
  const body = DecisionBody.safeParse(req.body ?? {});
  if (!decisionId.success || !body.success) {
    res.status(400).json({ error: { code: "invalid_request", message: "Choose a valid approval action." } });
    return;
  }
  try {
    const context = await resolveShopifyAppContext(authHeader(req));
    if (!context.user_id || context.role === "viewer") {
      res.status(403).json({ error: { code: "not_linked", message: "Sign in to Zavi with this Shopify staff email before approving work here." } });
      return;
    }
    const { data: row, error } = await tenantClient(asTenantId(context.tenant_id)).from("decisions")
      .select("decision_class, body, status")
      .eq("id", decisionId.data)
      .maybeSingle<{ decision_class: string; body: unknown; status: string }>();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "This approval was not found." } });
      return;
    }
    if (!oneClickApprovalAllowed({ role: context.role, decisionClass: row.decision_class, body: row.body })) {
      res.status(409).json({ error: { code: "full_review_required", message: "Open the full Zavi review for this action." } });
      return;
    }
    const result = await decideOnDecision({
      decision_id: decisionId.data,
      tenant_id: context.tenant_id,
      action: body.data.decision,
      actor: { user_id: context.user_id },
      surface: "web",
      offer_run_alone: false,
    });
    if (!result.ok) {
      const status = result.code === "not_found" || result.code === "cross_tenant" ? 404 : result.code === "not_member" || result.code === "not_authorized" ? 403 : 409;
      res.status(status).json({ error: { code: result.code, message: result.detail ?? "This approval changed. Reload and review it again." } });
      return;
    }
    res.json({ ok: true, changed: result.changed });
  } catch (error) {
    sendError(res, error);
  }
}

export async function shopifyAppHomeBilling(req: Request, res: Response): Promise<void> {
  const body = BillingBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_plan", message: "Choose a valid plan and term." } });
    return;
  }
  try {
    const context = req.shopifyAppContext ?? await resolveShopifyAppContext(authHeader(req));
    res.json(await startShopifySubscription(context, body.data.tier, body.data.term));
  } catch (error) {
    if (error instanceof ShopifyBillingStartError) {
      const status = error.code === "forbidden" ? 403 : error.code === "invalid_plan" ? 400 : ["paid_elsewhere", "grandfathered", "refund_blocked"].includes(error.code) ? 409 : 502;
      res.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    sendError(res, error);
  }
}

export async function shopifyAppHomeBillingAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await resolveShopifyAppContext(authHeader(req));
    if (!context.user_id || (context.role !== "owner" && context.role !== "admin")) {
      res.status(403).json({ error: { code: "forbidden", message: "Only a linked Zavi owner or admin can change this plan." } });
      return;
    }
    req.shopifyAppContext = context;
    req.idempotencyScope = { tenant_id: asTenantId(context.tenant_id), user_id: context.user_id };
    next();
  } catch (error) {
    sendError(res, error);
  }
}
