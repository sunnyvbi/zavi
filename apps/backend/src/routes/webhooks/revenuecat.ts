
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { storeBillingClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { requestPreviewUpgrade } from "@/services/growth/preview-upgrade";
import {
  sourceForStore,
  storeStateForEvent,
  type StoreEvent,
  type StoreSource,
  type StoreStatus,
} from "@/services/billing/store-rail";
import type { PaidTier } from "@/services/billing/tiers";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const ANONYMOUS_PREFIX = "$RCAnonymousID:";

export type StoreOutcome =
  | "applied"
  | "replay"
  | "stale"
  | "grandfathered"
  | "stripe_active"
  | "refund_blocked"
  | "store_account_in_use";

type DbError = { error: { message: string } | null };

type ApplyArgs = {
  tenant_id: string;
  source: StoreSource;
  store_app_user_id: string;
  store_product_id: string | null;
  tier: PaidTier | null;
  status: StoreStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  event_ms: number;
  refund_reversed: boolean;
  refund: boolean;
};

type Deps = {
  authSecret?: () => string | null;
  signingSecret?: () => string | null;
  allowSandbox?: () => boolean;
  nowMs?: () => number;
  eventProcessed?: (eventId: string) => Promise<boolean>;
  markProcessed?: (eventId: string, type: string) => Promise<void>;
  resolveTenantByStoreUser?: (appUserId: string) => Promise<string | null>;
  resolveTenantByBinding?: (appUserId: string) => Promise<string | null>;
  applyState?: (args: ApplyArgs) => Promise<DbError & { outcome: StoreOutcome | null }>;
  setMonthlyCredits?: (tenantId: string, eventSeconds: number) => Promise<DbError>;
  requestPreviewRerun?: (tenantId: string) => Promise<unknown>;
};

const db = () => storeBillingClient("RevenueCat webhook: no session, workspace resolved from store records");

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest();

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function signatureValid(raw: Buffer, header: string, secret: string, nowSeconds: number): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.`).update(raw).digest("hex");
  return v1.length === expected.length && safeEqual(v1, expected);
}

async function defaultEventProcessed(eventId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("revenuecat_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle<{ event_id: string }>();
  if (error) throw new Error(`event-processed check failed: ${error.message}`);
  return Boolean(data);
}

async function defaultMarkProcessed(eventId: string, type: string): Promise<void> {
  const { error } = await db().from("revenuecat_events").insert({ event_id: eventId, type });
  if (error && !/duplicate key|unique/i.test(error.message)) {
    throw new Error(`mark-processed failed: ${error.message}`);
  }
}

async function defaultResolveByStoreUser(appUserId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("tenant_subscriptions")
    .select("tenant_id")
    .eq("store_app_user_id", appUserId)
    .maybeSingle<{ tenant_id: string }>();
  if (error) throw new Error(`resolve-by-store-user failed: ${error.message}`);
  return data?.tenant_id ?? null;
}

async function defaultResolveByBinding(appUserId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("tenant_store_bindings")
    .select("tenant_id")
    .eq("user_id", appUserId)
    .maybeSingle<{ tenant_id: string }>();
  if (error) throw new Error(`resolve-by-binding failed: ${error.message}`);
  return data?.tenant_id ?? null;
}

async function defaultApplyState(args: ApplyArgs) {
  const { data, error } = (await db().rpc("apply_store_subscription_state", {
    p_tenant_id: args.tenant_id,
    p_source: args.source,
    p_store_app_user_id: args.store_app_user_id,
    p_store_product_id: args.store_product_id,
    p_tier: args.tier,
    p_status: args.status,
    p_current_period_end: args.current_period_end,
    p_cancel_at_period_end: args.cancel_at_period_end,
    p_event_ms: args.event_ms,
    p_refund_reversed: args.refund_reversed,
    p_refund: args.refund,
  })) as unknown as { data: StoreOutcome | null; error: { message: string } | null };
  return { error, outcome: data };
}

function defaultSetMonthlyCredits(tenantId: string, eventSeconds: number) {
  return db().rpc("set_tenant_monthly_credits", {
    p_tenant_id: tenantId,
    p_monthly_credits: null,
    p_monthly_usd: null,
    p_event_created: eventSeconds,
  }) as unknown as Promise<DbError>;
}

export function makeRevenueCatWebhook(deps: Deps = {}) {
  const authSecret = deps.authSecret ?? (() => process.env.REVENUECAT_WEBHOOK_AUTH ?? null);
  const signingSecret = deps.signingSecret ?? (() => process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET ?? null);
  const allowSandbox = deps.allowSandbox ?? (() => process.env.REVENUECAT_ALLOW_SANDBOX === "true");
  const nowMs = deps.nowMs ?? Date.now;
  const eventProcessed = deps.eventProcessed ?? defaultEventProcessed;
  const markProcessed = deps.markProcessed ?? defaultMarkProcessed;
  const resolveByStoreUser = deps.resolveTenantByStoreUser ?? defaultResolveByStoreUser;
  const resolveByBinding = deps.resolveTenantByBinding ?? defaultResolveByBinding;
  const applyState = deps.applyState ?? defaultApplyState;
  const setMonthlyCredits = deps.setMonthlyCredits ?? defaultSetMonthlyCredits;
  const requestPreviewRerun = deps.requestPreviewRerun ?? requestPreviewUpgrade;

  return async function revenueCatWebhook(req: Request, res: Response): Promise<void> {
    const expectedAuth = authSecret();
    if (!expectedAuth) {
      res.status(503).json({ error: { code: "revenuecat_webhook_disabled", message: "REVENUECAT_WEBHOOK_AUTH unset" } });
      return;
    }
    if (!safeEqual(String(req.header("authorization") ?? ""), expectedAuth)) {
      res.status(401).json({ error: { code: "bad_authorization", message: "authorization header does not match" } });
      return;
    }

    const raw = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

    const signing = signingSecret();
    if (signing) {
      const header = String(req.header("x-revenuecat-webhook-signature") ?? "");
      if (!signatureValid(raw, header, signing, Math.floor(nowMs() / 1000))) {
        res.status(401).json({ error: { code: "bad_signature", message: "webhook signature did not verify" } });
        return;
      }
    }

    let event: StoreEvent;
    try {
      event = (JSON.parse(raw.toString("utf8")) as { event?: StoreEvent }).event ?? {};
    } catch {
      res.status(400).json({ error: { code: "bad_body", message: "body is not valid JSON" } });
      return;
    }
    if (typeof event.id !== "string" || typeof event.type !== "string") {
      res.status(400).json({ error: { code: "bad_event", message: "event id or type missing" } });
      return;
    }
    const eventId = event.id;
    const eventType = event.type;

    if (eventType === "TEST") {
      res.status(200).json({ ok: true, test: true });
      return;
    }

    const isTestTraffic = event.environment === "SANDBOX" || event.store === "TEST_STORE";
    if (isTestTraffic && !allowSandbox()) {
      res.status(200).json({ ok: true, ignored: "sandbox" });
      return;
    }

    const source = sourceForStore(event.store);
    if (!source) {
      res.status(200).json({ ok: true, ignored: `store:${String(event.store)}` });
      return;
    }

    const state = storeStateForEvent(event);
    if (state.kind === "ignore") {
      res.status(200).json({ ok: true, ignored: state.reason });
      return;
    }
    if (state.kind === "unknown_product") {
      await logEvent({
        level: "error",
        source: "revenuecat-webhook",
        code: "store_unknown_product",
        message: `${eventType} carries a product this backend cannot map to a tier: ${String(event.product_id)}`,
      });
      res.status(500).json({ error: { code: "unknown_product", message: "product id does not map to a tier" } });
      return;
    }

    try {
      if (await eventProcessed(eventId)) {
        res.status(200).json({ ok: true, duplicate: eventId });
        return;
      }

      const appUserId = typeof event.app_user_id === "string" ? event.app_user_id : "";
      let tenantId: string | null = null;
      if (appUserId && !appUserId.startsWith(ANONYMOUS_PREFIX)) {
        tenantId =
          eventType === "INITIAL_PURCHASE"
            ? (await resolveByBinding(appUserId)) ?? (await resolveByStoreUser(appUserId))
            : (await resolveByStoreUser(appUserId)) ?? (await resolveByBinding(appUserId));
      }
      if (!tenantId) {
        await logEvent({
          level: eventType === "INITIAL_PURCHASE" || eventType === "RENEWAL" ? "error" : "warn",
          source: "revenuecat-webhook",
          code: "store_event_unbound",
          message: `${eventType} ${eventId} has no workspace binding; nothing was applied`,
        });
        res.status(200).json({ ok: true, unbound: true });
        return;
      }

      const eventMs = typeof event.event_timestamp_ms === "number" ? event.event_timestamp_ms : nowMs();
      const eventSeconds = Math.floor(eventMs / 1000);

      const applied = await applyState({
        tenant_id: tenantId,
        source,
        store_app_user_id: appUserId,
        store_product_id: typeof event.product_id === "string" ? event.product_id : null,
        tier: state.tier,
        status: state.status,
        current_period_end: state.periodEnd,
        cancel_at_period_end: state.cancelAtPeriodEnd,
        event_ms: eventMs,
        refund_reversed: state.refundReversed,
        refund: state.refund,
      });
      if (applied.error || !applied.outcome) {
        res.status(500).json({ error: { code: "apply_failed", message: applied.error?.message ?? "no outcome" } });
        return;
      }

      const outcome = applied.outcome;
      if (outcome !== "applied" && outcome !== "replay") {
        if (outcome !== "stale") {
          await logEvent({
            level: "error",
            source: "revenuecat-webhook",
            code: "store_state_conflict",
            tenant_id: tenantId,
            message: `${eventType} ${eventId} was not applied: ${outcome}. Check whether the customer was charged and needs a refund.`,
          });
        }
        await markProcessed(eventId, eventType);
        res.status(200).json({ ok: true, type: eventType, outcome });
        return;
      }

      const { error: creditsErr } = await setMonthlyCredits(tenantId, eventSeconds);
      if (creditsErr) {
        res.status(500).json({ error: { code: "set_credits_failed", message: creditsErr.message } });
        return;
      }

      if (!state.refund && state.tier && !state.cancelAtPeriodEnd && (state.status === "active" || state.status === "trialing")) {
        try {
          await requestPreviewRerun(tenantId);
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "revenuecat-webhook",
            code: "preview_rerun_request_failed",
            tenant_id: tenantId,
            error: e,
          });
          res.status(500).json({ error: { code: "preview_rerun_request_failed", message: "Could not queue the upgraded channels." } });
          return;
        }
      }

      await markProcessed(eventId, eventType);
      res.status(200).json({ ok: true, type: eventType, outcome });
    } catch (e) {
      await logEvent({
        level: "error",
        source: "revenuecat-webhook",
        code: "store_webhook_failed",
        message: `${eventType} ${eventId} failed: ${(e as Error).message}`,
      });
      res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
    }
  };
}

export const revenueCatWebhook = makeRevenueCatWebhook();
