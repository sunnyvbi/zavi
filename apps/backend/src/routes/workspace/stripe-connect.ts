
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole, loadTenantRole } from "@/services/auth/tenant-role";
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import { resolveConnectedAccountId } from "@/services/tools/stripe/_platform-client";
import { resolvePayoutAccountState } from "@/services/tools/stripe/payout-account";
import { createOnboardingLink } from "@/services/tools/stripe/onboarding-link";
import { createStripeConnectProvisioner } from "@/services/provisioning/stripe-connect";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";

const WRITE_ROLES = ["owner", "admin"] as const;

function isRailGated(e: unknown): boolean {
  if (e instanceof CredentialNotConfigured) return true;
  return (
    e instanceof ExpectedToolError &&
    (e.code === "stripe_platform_not_configured" ||
      e.code === "stripe_provisioning_disabled")
  );
}

function cleanStripeCreateError(e: unknown): string | null {
  const msg = (e as Error)?.message ?? "";
  if (!/stripe account create failed/i.test(msg)) return null;
  const jsonStart = msg.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(msg.slice(jsonStart)) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
    }
  }
  return "Stripe could not create the payout account. Check that Connect is enabled on the platform account.";
}

export async function getStripePayoutAccount(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [state, role] = await Promise.all([
      resolvePayoutAccountState(auth.tenant_id),
      loadTenantRole(auth),
    ]);
    res.json({ ...state, role, can_write: role === "owner" || role === "admin" });
  } catch (e) {
    res.status(500).json({
      error: { code: "payout_status_failed", message: (e as Error).message },
    });
  }
}

export async function postStripePayoutAccount(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const company_name =
    typeof (req.body as { company_name?: unknown })?.company_name === "string"
      ? (req.body as { company_name: string }).company_name.trim()
      : "";

  try {
    const existing = await resolveConnectedAccountId(auth.tenant_id);
    if (existing) {
      const onboarding_url = await createOnboardingLink(existing).catch(() => null);
      res.json({
        created: false,
        account_id: existing,
        onboarding_url,
        state: "exists",
      });
      return;
    }

    if (!company_name || company_name.length > 100) {
      res.status(400).json({
        error: { code: "bad_request", message: "company_name is required (1..100 chars)" },
      });
      return;
    }

    const provisioner = createStripeConnectProvisioner();
    const result = await provisioner.ensure({ tenant_id: auth.tenant_id, company_name });
    const { error } = await serviceClient().rpc("set_tenant_resource", {
      p_tenant_id: auth.tenant_id,
      p_resource_kind: "stripe",
      p_mode: "provisioned",
      p_status: "ready",
      p_provider: provisioner.provider,
      p_external_ref: result.external_ref,
      p_vault_key: null,
    });
    if (error) {
      res.status(500).json({
        error: { code: "persist_failed", message: error.message },
      });
      return;
    }

    const acctId =
      typeof result.external_ref.stripe_account_id === "string"
        ? result.external_ref.stripe_account_id
        : null;
    const onboarding_url =
      typeof result.external_ref.onboarding_url === "string"
        ? result.external_ref.onboarding_url
        : null;

    await logEvent({
      level: "info",
      source: "stripe_payout_settings",
      code: "stripe.payout_account.created",
      tenant_id: auth.tenant_id,
    });

    res.json({ created: true, account_id: acctId, onboarding_url, state: "no_account" });
  } catch (e) {
    if (isRailGated(e)) {
      res.json({ created: false, state: "rail_disabled" });
      return;
    }
    const clean = cleanStripeCreateError(e);
    if (clean) {
      await logEvent({
        level: "warn",
        source: "stripe_payout_settings",
        code: "stripe.payout_account.create_rejected",
        tenant_id: auth.tenant_id,
        error: e,
      });
      res.status(502).json({ error: { code: "stripe_create_failed", message: clean } });
      return;
    }
    res.status(500).json({
      error: { code: "create_failed", message: (e as Error).message },
    });
  }
}

export async function postStripeOnboardingLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  try {
    const acctId = await resolveConnectedAccountId(auth.tenant_id);
    if (!acctId) {
      res.status(400).json({
        error: { code: "no_account", message: "No payout account exists yet. Create one first." },
      });
      return;
    }
    const onboarding_url = await createOnboardingLink(acctId);
    res.json({ onboarding_url });
  } catch (e) {
    if (isRailGated(e)) {
      res.json({ state: "rail_disabled" });
      return;
    }
    res.status(500).json({
      error: { code: "onboarding_link_failed", message: (e as Error).message },
    });
  }
}

export async function postStripeMoneyModel(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const money_model = (req.body as { money_model?: unknown })?.money_model;
  if (money_model !== "path_a" && money_model !== "path_b") {
    res.status(400).json({
      error: { code: "bad_request", message: "money_model must be 'path_a' or 'path_b'" },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("set_tenant_money_model", {
    p_tenant_id: auth.tenant_id,
    p_money_model: money_model,
  });
  if (error) {
    res.status(500).json({
      error: { code: "set_money_model_failed", message: error.message },
    });
    return;
  }
  res.json({ money_model });
}
