import { stripeAdsWebhook } from "./routes/webhooks/stripe-ads";

import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { serve as serveInngest } from "inngest/express";

import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { creatorMarketplaceApiPath } from "@zavi/shared";
import { tokenPerClientRateLimit, tokenPerIpCeiling } from "@/services/auth/oauth/token-rate-limit";
import { mountRoutes } from "./routes";
import { forwardAsyncErrors } from "./services/http/async-errors";
import { buildRequestJson } from "./services/http/build-request-json";
import { praxisOAuthProvider } from "./services/auth/oauth/provider";
import { MCP_RESOURCE } from "./services/auth/oauth/tokens";
import { adminRouter } from "./routes/admin";
import { membersRouter } from "./routes/members";
import { tenantsRouter } from "./routes/tenants";
import { checkDbReachable, checkSchemaInvariants } from "./services/dbInvariants";
import { wireCreatorMoneyPort } from "./services/creators/offer-money-port";
import { setSiteFunctionsService } from "./services/site-functions/contract";
import { createSiteFunctionsService } from "./services/site-functions/service";
import {
  channelRecipesPresent,
  RECIPES_MISSING_REASON,
} from "./services/channels/recipe";
import { isLocalhostDevOrigin } from "./services/cors-origin";
import { resolveInngestServeHost, resolveIssuerUrl } from "./services/config/env-targets";
import { getLiveness, startLivenessSampler } from "./services/liveness";
import { logEvent, type LogEventInput } from "./services/logging/logEvent";
import { inngestDrainMiddleware } from "./services/agents/inngest-drain";
import { inngest } from "../workers/client";
import { inngestFunctions } from "../workers/functions";
import { eventOnlyInngestFunctions } from "@/services/config/inngest-event-only";
import { processRole, servesInngest } from "@/services/config/process-role";
import { inngestSyncGuard } from "@/services/inngest-sync-guard";
import { slackWebhook } from "./routes/webhooks/slack";
import { slackInteractionsWebhook } from "./routes/webhooks/slack-interactions";
import { teamsWebhook } from "./routes/webhooks/teams";
import { telegramWebhook } from "./routes/webhooks/telegram";
import { whatsappWebhook, whatsappWebhookVerify } from "./routes/webhooks/whatsapp";
import { imessageWebhook } from "./routes/webhooks/imessage";
import { githubWebhook } from "./routes/webhooks/github";
import { shopifyWebhook } from "./routes/webhooks/shopify";
import { emailWebhook } from "./routes/webhooks/email";
import { sendgridEventsWebhook } from "./routes/webhooks/sendgrid-events";
import { emailUnsubscribe } from "./routes/email/unsubscribe";
import { getCreatorInviteUnsubscribe, postCreatorInviteUnsubscribe } from "./routes/creators/invite-unsubscribe";
import { getCreatorInvitePrefill } from "./routes/creators/invite-prefill";
import { getSiteFormUnsubscribe, postSiteFormUnsubscribe } from "./routes/public/site-form-unsubscribe";
import { getOnboardingEmailUnsubscribe, postOnboardingEmailUnsubscribe } from "./routes/onboarding-emails/unsubscribe";
import { stripeWebhook } from "./routes/webhooks/stripe";
import { stripeBillingWebhook } from "./routes/webhooks/stripe-billing";
import { revenueCatWebhook } from "./routes/webhooks/revenuecat";
import { creatorStripeWebhook } from "./routes/webhooks/stripe-creators";
import { recallWebhook } from "./routes/webhooks/recall";
import { siteAuthRoute } from "./routes/public/site-auth";
import { siteAuthSendEmailHook } from "./routes/public/site-auth-hook";
import { authSendEmailHook } from "./routes/auth/send-email-hook";
import { sitePageView } from "./routes/public/site-pageview";
import { siteFunctionLogsWebhook } from "./routes/webhooks/site-function-logs";
import { metaAdsDeauthorize } from "./routes/connectors/meta-ads";
import { geoCrawlerIngest } from "./routes/geo";
import { geoIngestLimiters } from "./services/tools/growth/geo/crawler-hits/ingest-limit";
import { linkedinAdsCallLog } from "./services/connectors/linkedin-ads/http";
import {
  isProductBuilderUnavailable,
  respondProductBuilderUnavailable,
} from "./agents/engineer/product-builder-unavailable";

export function classifyClientRequestError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  const e = err as Error & { type?: string; status?: number; statusCode?: number };

  if (
    e?.type === "entity.parse.failed" ||
    ((e?.status === 400 || e?.statusCode === 400) && err instanceof SyntaxError)
  ) {
    return { status: 400, code: "invalid_json", message: "Request body is not valid JSON." };
  }

  if (e?.type === "entity.too.large" || e?.status === 413 || e?.statusCode === 413) {
    return {
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large (limit 1MB). Send a shorter request.",
    };
  }

  return null;
}

export function unhandledRouteErrorLog(err: Error, req: Request): LogEventInput {
  return {
    level: "error",
    source: "route",
    code: "http_5xx",
    error: err,
    tenant_id: req.auth?.tenant_id ?? null,
    meta: {
      http_status: 500,
      method: req.method,
      path: req.path,
      error_class: err.name,
    },
  };
}

export function creatorMarketplaceUnavailable(
  req: Pick<Request, "path" | "method">,
  res: Pick<Response, "status" | "json">,
  next: NextFunction,
): void {
  if (!creatorMarketplaceApiPath(req.path, req.method)) return next();
  res.status(410).json({
    error: {
      code: "creator_marketplace_unavailable",
      message: "The external creator marketplace is not available.",
    },
  });
}

export function createApp(): Express {
  const app = express();
  forwardAsyncErrors(app);

  app.set("trust proxy", 1);

  startLivenessSampler();

  wireCreatorMoneyPort();

  setSiteFunctionsService(createSiteFunctionsService());

  const FIRST_PARTY_ORIGINS = [
    "https://www.zaviagent.com",
    "https://zaviagent.com",
    "https://admin.zaviagent.com",
    "https://latest.zaviagent.com",
    "https://admin-latest.zaviagent.com",
  ];
  const origins = Array.from(
    new Set([
      ...(process.env.WEB_ORIGIN || "http://localhost:3000")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      ...FIRST_PARTY_ORIGINS,
    ]),
  );
  const ALLOWED = new Set(origins);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || ALLOWED.has(origin) || isLocalhostDevOrigin(origin)) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      },
      credentials: false,
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    }),
  );

  app.use(creatorMarketplaceUnavailable);

  app.post(
    "/api/webhooks/slack",
    express.raw({ type: "application/json", limit: "1mb" }),
    slackWebhook,
  );
  app.post(
    "/api/webhooks/slack/interactions",
    express.raw({ type: "application/x-www-form-urlencoded", limit: "1mb" }),
    slackInteractionsWebhook,
  );
  app.post(
    "/api/webhooks/github",
    express.raw({ type: "application/json", limit: "1mb" }),
    githubWebhook,
  );
  app.post(
    "/api/webhooks/shopify",
    express.raw({ type: () => true, limit: "1mb" }),
    shopifyWebhook,
  );
  app.post(
    "/api/webhooks/teams",
    express.json({ type: "application/json", limit: "1mb" }),
    teamsWebhook,
  );
  app.post(
    "/api/webhooks/telegram",
    express.json({ type: "application/json", limit: "1mb" }),
    telegramWebhook,
  );
  app.get("/api/webhooks/whatsapp", whatsappWebhookVerify);
  app.post(
    "/api/webhooks/whatsapp",
    express.raw({ type: "application/json", limit: "1mb" }),
    whatsappWebhook,
  );
  app.post(
    "/api/webhooks/imessage",
    express.json({ type: "application/json", limit: "1mb" }),
    imessageWebhook,
  );
  app.post(
    "/api/webhooks/email",
    express.raw({ type: "application/json", limit: "10mb" }),
    emailWebhook,
  );
  app.post(
    "/api/webhooks/sendgrid",
    express.raw({ type: "application/json", limit: "1mb" }),
    sendgridEventsWebhook,
  );
  app.get("/api/email/unsubscribe", emailUnsubscribe);
  app.post("/api/email/unsubscribe", express.urlencoded({ extended: false }), emailUnsubscribe);
  app.get("/api/creators/invite/unsubscribe", getCreatorInviteUnsubscribe);
  app.post("/api/creators/invite/unsubscribe", express.urlencoded({ extended: false }), postCreatorInviteUnsubscribe);
  app.get("/api/creators/invite/prefill", getCreatorInvitePrefill);
  app.get("/api/onboarding-emails/unsubscribe", getOnboardingEmailUnsubscribe);
  app.post("/api/onboarding-emails/unsubscribe", express.urlencoded({ extended: false }), postOnboardingEmailUnsubscribe);
  app.get("/api/public/site-forms/unsubscribe", getSiteFormUnsubscribe);
  app.post("/api/public/site-forms/unsubscribe", express.urlencoded({ extended: false }), postSiteFormUnsubscribe);
  app.post(
    "/api/public/sites/pageview",
    express.raw({ type: "application/json", limit: "4kb" }),
    sitePageView,
  );
  app.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    stripeWebhook,
  );
  app.post("/api/webhooks/stripe/ads", express.raw({ type: "application/json", limit: "1mb" }), stripeAdsWebhook);
  app.post(
    "/api/webhooks/stripe/billing",
    express.raw({ type: "application/json", limit: "1mb" }),
    stripeBillingWebhook,
  );
  app.post(
    "/api/webhooks/revenuecat",
    express.raw({ type: "application/json", limit: "1mb" }),
    revenueCatWebhook,
  );
  app.post("/api/auth/hooks/send-email", express.raw({ type: () => true, limit: "64kb" }), authSendEmailHook);
  app.post(
    "/api/public/site-auth/hooks/send-email/:shardId",
    express.raw({ type: () => true, limit: "64kb" }),
    siteAuthSendEmailHook,
  );
  app.post("/api/public/site-auth/:op", express.raw({ type: () => true, limit: "16kb" }), siteAuthRoute);
  app.post("/api/webhooks/site-functions/logs", express.raw({ type: () => true, limit: "1mb" }), siteFunctionLogsWebhook);
  app.get("/api/public/site-auth/:op", siteAuthRoute);
  app.post(
    "/api/webhooks/stripe/creators",
    express.raw({ type: "application/json", limit: "1mb" }),
    creatorStripeWebhook,
  );

  const metaDeauthorizeLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "too many deauthorize callbacks" },
      }),
  });
  app.post(
    "/api/connectors/meta-ads/deauthorize",
    metaDeauthorizeLimiter,
    express.urlencoded({ extended: false, limit: "64kb" }),
    express.json({ type: "application/json", limit: "64kb" }),
    metaAdsDeauthorize,
  );

  app.post(
    "/api/geo/crawler-hits/ingest",
    ...geoIngestLimiters(),
    express.raw({ type: () => true, limit: "10mb" }),
    geoCrawlerIngest,
  );

  app.post(
    "/api/webhooks/recall",
    express.raw({ type: "application/json", limit: "1mb" }),
    recallWebhook,
  );

  const chatJson = express.json({ limit: "640kb" });
  app.use((req, res, next) => {
    if (
      req.method === "POST" &&
      /^\/api\/agents\/[^/]+\/chat\/?$/.test(req.path)
    ) {
      return chatJson(req, res, next);
    }
    return next();
  });
  app.use(buildRequestJson());
  app.use(linkedinAdsCallLog);

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get("/livez", (_req, res) => {
    const live = getLiveness();
    res.status(live.ok ? 200 : 503).json({ service: "praxis-backend", ...live });
  });

  app.get("/health/ready", async (_req, res) => {
    const r = await checkDbReachable();
    if (r.db === "down") console.warn(`[health/ready] db down: ${r.reason}`);
    res.set("Cache-Control", "no-store");
    res.status(r.db === "up" ? 200 : 503).json({ service: "praxis-backend", db: r.db });
  });

  app.get("/health", async (_req, res) => {
    const base = { service: "praxis-backend", uptime_s: process.uptime() };
    let inv;
    try {
      inv = await checkSchemaInvariants();
    } catch (e) {
      return res.status(503).json({
        ok: false,
        ...base,
        reason: `health_check_exception: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (!inv.ok) {
      return res.status(503).json({ ok: false, ...base, reason: inv.reason });
    }
    if (!channelRecipesPresent()) {
      return res
        .status(503)
        .json({ ok: false, ...base, reason: RECIPES_MISSING_REASON });
    }
    return res.json({ ok: true, ...base });
  });

  if (servesInngest(processRole())) {
    app.use(
      "/api/inngest",
      inngestDrainMiddleware,
      inngestSyncGuard(),
      serveInngest({
        client: inngest,
        functions: eventOnlyInngestFunctions(inngestFunctions),
        serveHost: resolveInngestServeHost(),
        streaming: "force",
      }),
    );
  }

  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
    res.set("Cache-Control", "no-store");
    if (!token) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.type("text/plain").send(token);
  });

  const issuerUrl = new URL(resolveIssuerUrl());
  app.use("/token", tokenPerIpCeiling);
  app.use(
    mcpAuthRouter({
      provider: praxisOAuthProvider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl: new URL(MCP_RESOURCE),
      scopesSupported: ["read", "run", "offline_access"],
      resourceName: "Zavi",
      tokenOptions: { rateLimit: tokenPerClientRateLimit },
    }),
  );

  mountRoutes(app);

  app.use("/api/admin", adminRouter());

  app.use("/api/v1/members", membersRouter());

  app.use("/api/v1/tenants", tenantsRouter());

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { code: "not_found", message: `${req.method} ${req.path} not found` },
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (isProductBuilderUnavailable(err)) {
      respondProductBuilderUnavailable(res);
      return;
    }
    const clientErr = classifyClientRequestError(err);
    if (clientErr) {
      res.status(clientErr.status).json({
        error: { code: clientErr.code, message: clientErr.message },
      });
      return;
    }

    console.error("[zavi-backend] unhandled error:", err);
    void logEvent(unhandledRouteErrorLog(err, req));
    res.status(500).json({
      error: {
        code: "internal_error",
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error."
            : err.message || "unknown error",
      },
    });
  });

  return app;
}
