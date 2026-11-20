
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { getBoolSetting, getStringSetting } from "@/services/settings";
import { serverClientFromBearer } from "@/services/supabase";
import { readProgressRow, readSetupDraftRuns, readSetupState, type SetupResponse, type SetupState } from "@/services/setup/state";
import { asTenantId } from "@/services/tenant-client";
import { FleetHaltedError, InsufficientCreditsError } from "@/services/agents/runner";
import { nextSetupAttempt } from "@/services/growth/setup-draft";
import { reconcileSetupDraftRefunds } from "@/services/growth/setup-draft-refund";
import { startSetupDraftAttempt } from "@/services/setup/draft-start";

const SETTING = "welcome_setup_enabled";
const BUILD_OPEN = "build_signup_lands_on_build";
const CODING_PROMPT_TUCKED = "setup_coding_prompt_tucked";
const ONE_STATE = "setup_strategy_one_state";
const SKIP_NO_CONFIRM = "setup_skip_no_confirm";
const BUILD_APP_INTENT = "build_app_intent";

type SetupFlags = {
  build_open?: true;
  coding_prompt_tucked?: true;
  one_state?: true;
  skip_no_confirm?: true;
  from_scratch?: true;
};

async function withBuildOpen(state: SetupResponse, tenantId: string): Promise<SetupResponse | (SetupState & SetupFlags)> {
  if (!state.enabled) return state;
  const [buildOpen, tucked, oneState, skipNoConfirm, buildIntent] = await Promise.all([
    getBoolSetting(BUILD_OPEN, tenantId),
    getBoolSetting(CODING_PROMPT_TUCKED, tenantId),
    getBoolSetting(ONE_STATE, tenantId),
    getBoolSetting(SKIP_NO_CONFIRM, tenantId),
    getStringSetting(BUILD_APP_INTENT, tenantId).catch(() => "existing"),
  ]);
  return {
    ...state,
    ...(buildOpen ? { build_open: true as const } : {}),
    ...(buildIntent === "fresh" ? { from_scratch: true as const } : {}),
    ...(tucked ? { coding_prompt_tucked: true as const } : {}),
    ...(oneState ? { one_state: true as const } : {}),
    ...(skipNoConfirm ? { skip_no_confirm: true as const } : {}),
  };
}

const ProgressBody = z.union([
  z.object({ step: z.enum(["docs", "connectors"]), outcome: z.enum(["done", "skipped"]) }),
  z.object({ step: z.enum(["done", "home"]) }),
]);

const KIND = {
  docs: "setup_docs",
  connectors: "setup_connectors",
  done: "setup_done",
  home: "setup_home",
} as const;

export async function getSetup(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  await reconcileSetupDraftRefunds(auth.tenant_id).catch((e: unknown) =>
    console.warn(`[setup] setup draft reconcile failed for ${auth.tenant_id}: ${(e as Error).message}`),
  );
  try {
    if (!(await getBoolSetting(SETTING, auth.tenant_id))) {
      res.json({ enabled: false });
      return;
    }
    res.json(await withBuildOpen(await readSetupState(auth.tenant_id, serverClientFromBearer(auth.access_token)), auth.tenant_id));
  } catch (e) {
    res.status(500).json({ error: { code: "setup_read_failed", message: (e as Error).message } });
  }
}

export async function postSetupProgress(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const parsed = ProgressBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: parsed.error.message } });
    return;
  }
  if (!(await getBoolSetting(SETTING, auth.tenant_id))) {
    res.status(409).json({ error: { code: "setup_off", message: "Setup is turned off." } });
    return;
  }
  const body = parsed.data;
  const key = "outcome" in body ? body.outcome : "done";
  const sb = serverClientFromBearer(auth.access_token);
  const { error } = await sb.rpc("mark_first_run_progress", {
    p_tenant_id: auth.tenant_id,
    p_kind: KIND[body.step],
    p_key: key,
  });
  if (error) {
    res.status(500).json({ error: { code: "setup_write_failed", message: error.message } });
    return;
  }
  try {
    res.json(await withBuildOpen(await readSetupState(auth.tenant_id, sb), auth.tenant_id));
  } catch (e) {
    res.status(500).json({ error: { code: "setup_read_failed", message: (e as Error).message } });
  }
}

const DraftBody = z.object({ retry: z.boolean().optional(), paid: z.boolean().optional() });

export async function postSetupDraft(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const parsed = DraftBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: parsed.error.message } });
    return;
  }
  if (!(await getBoolSetting(SETTING, auth.tenant_id))) {
    res.status(409).json({ error: { code: "setup_off", message: "Setup is turned off." } });
    return;
  }
  const tid = asTenantId(auth.tenant_id);
  try {
    const progress = await readProgressRow(tid);
    if (!progress?.setup_connectors_at) {
      res.status(409).json({ error: { code: "not_ready", message: "Finish or skip the connectors step first." } });
      return;
    }
    const sb = serverClientFromBearer(auth.access_token);
    const [runs, planRes] = await Promise.all([
      readSetupDraftRuns(tid),
      sb.from("growth_plan").select("id").eq("tenant_id", auth.tenant_id).eq("status", "live").limit(1),
    ]);
    if (planRes.error) throw new Error(planRes.error.message);
    if (parsed.data.retry && runs[0]) {
      const { readStrategyDelivery, applySavedStrategy } = await import("@/services/growth/strategy-delivery");
      const saved = await readStrategyDelivery(auth.tenant_id, runs[0].id);
      if (saved?.artifact && saved.phase !== "superseded") {
        const receipt = await applySavedStrategy(auth.tenant_id, runs[0].id);
        if (receipt.phase === "applied") { res.json({ status: "saved", run_id: runs[0].id }); return; }
      }
    }
    const next = nextSetupAttempt(
      auth.tenant_id, runs, (planRes.data ?? []).length > 0, parsed.data.retry === true, parsed.data.paid === true,
    );
    if ("existing" in next) {
      res.json({ status: "already", run_id: next.existing });
      return;
    }
    if ("refused" in next) {
      res.status(409).json({ error: { code: next.refused, message: "No refunded draft to start right now." } });
      return;
    }
    res.json(await startSetupDraftAttempt(auth.tenant_id, next, sb));
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      res.status(402).json({
        error: { code: "insufficient_credits", message: "Not enough credits to draft a strategy. Top up and try again." },
      });
      return;
    }
    if (e instanceof FleetHaltedError) {
      res.status(503).json({ error: { code: "fleet_halted", message: "Agents are paused right now. Try again shortly." } });
      return;
    }
    res.status(500).json({ error: { code: "draft_failed", message: (e as Error).message } });
  }
}
