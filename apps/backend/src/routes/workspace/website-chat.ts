
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { saveOwnerChatFacts } from "@/services/company/owner-chat-facts";
import { serviceClient } from "@/services/supabase";
import {
  refineProduct,
  NoProvisionedRepo,
  BuildRetired,
  ConductorRunNotFound,
  InvalidRefineMessage,
  FleetHalted,
  AppFrozen,
  SitePreviewRestarting,
  UndoInProgress,
  FreeEditsUsed,
  SiteRequired,
  SiteUnavailable,
  OldSiteFrozen,
  realRefineProductDeps,
  siteChangesWaitForPublish,
} from "@/services/agents/refine-product";
import { OLD_SITE_FROZEN_STATUS, oldSiteFrozenBody } from "@/services/sites/old-site-freeze";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { refusalFor } from "@/services/agents/refusal";
import {
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
} from "@/services/agents/start-product-build";
import { appBuildScope } from "@/services/agents/whole-app-intent";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import {
  DATA_DELETE_NOTE,
  isAppEditIntent,
  isDestructiveDataEdit,
  isSiteChatEditIntent,
} from "@/services/agents/app-edit-intent";
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
} from "@/services/onboarding/enrichment/sanitize";
import { logEvent } from "@/services/logging/logEvent";
import type { DrainDeps, QueuedChangeStore } from "@/services/sites/queued-change";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { inngest } from "../../../workers/client";
import { getBoolSetting } from "@/services/settings";
import { findSecretLikeTokens, SECRET_IN_CHAT_MESSAGE } from "@/services/site-functions/contract";

export const APP_EDIT_CONFIRM_PR = "Make this change to your app? This opens a pull request for review.";
export const APP_EDIT_CONFIRM_AUTO_PUBLISH =
  "Make this change to your app? Once it's built, it goes live on your site automatically.";
export const APP_EDIT_CONFIRM_PREVIEW =
  "Make this change to your site? When it's built, it's ready to review in your preview. Click Publish to put it live.";

async function readFlag(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await read()) === true;
  } catch {
    return false;
  }
}

export async function appEditConfirmPrompt(tenant_id: string, opts: { site?: boolean } = {}): Promise<string> {
  if (opts.site) {
    if (!(await readFlag(() => getBoolSetting("refine_direct_merge_enabled", tenant_id)))) return APP_EDIT_CONFIRM_PR;
    const waits = await siteChangesWaitForPublish(tenant_id, (t) => getBoolSetting("build_publish_on_request", t));
    return waits ? APP_EDIT_CONFIRM_PREVIEW : APP_EDIT_CONFIRM_AUTO_PUBLISH;
  }
  if (!(await readFlag(() => getBoolSetting("website_chat_confirm_copy_by_path", tenant_id)))) {
    return APP_EDIT_CONFIRM_PR;
  }
  if (await readFlag(() => getBoolSetting("refine_direct_merge_enabled", tenant_id))) {
    return APP_EDIT_CONFIRM_AUTO_PUBLISH;
  }
  return APP_EDIT_CONFIRM_PR;
}

const MIN_MESSAGE_LEN = 8;
const MIN_SCOPED_MESSAGE_LEN = 2;
const MAX_SCOPED_MESSAGE = 2500;
const MAX_MESSAGE_LEN = 4000;

const DISPATCH_ROLES = ["owner", "admin", "member"] as const;

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export type EditabilityVerdict =
  | { editable: true }
  | { editable: false; reason: "no_built_app" | "previewing_own_site" };

export function deriveWebsiteEditability(input: {
  marketingUrl: string | null;
  builtAppUrl: string | null;
  boundBuild?: boolean;
}): EditabilityVerdict {
  const builtHost = hostOf(input.builtAppUrl);
  if (!builtHost) return { editable: false, reason: "no_built_app" };
  if (input.boundBuild) return { editable: true };
  const previewHost = hostOf(input.marketingUrl) ?? builtHost;
  return previewHost === builtHost
    ? { editable: true }
    : { editable: false, reason: "previewing_own_site" };
}

export type RejectionShape = { status: number; code: string; chat: string; action?: { kind: "rebuild_old_site"; label: string } };

export function mapRefineRejection(e: unknown): RejectionShape {
  if (e instanceof OldSiteFrozen) {
    const { error } = oldSiteFrozenBody();
    return { status: OLD_SITE_FROZEN_STATUS, code: error.code, chat: error.chat, action: error.action };
  }
  if (e instanceof InvalidRefineMessage) {
    return {
      status: 400,
      code: "invalid_refine_message",
      chat: "I need a bit more detail to change the app — describe what you want different in a sentence or two.",
    };
  }
  if (e instanceof NoProvisionedRepo) {
    return {
      status: 409,
      code: "no_provisioned_repo",
      chat: "There's no app wired up for this workspace yet, so there's nothing for me to change.",
    };
  }
  if (e instanceof SiteRequired) {
    return {
      status: e.reason === "ambiguous" ? 409 : 503,
      code: e.reason === "ambiguous" ? "site_required" : "site_unreadable",
      chat:
        e.reason === "ambiguous"
          ? "You have more than one site, so I can't tell which one to change from here. Open that site under Build and ask there."
          : "I couldn't check which site to change just now, so nothing was started. Try again in a moment.",
    };
  }
  if (e instanceof SiteUnavailable) {
    return { status: 409, code: "site_unavailable", chat: e.message };
  }
  if (e instanceof ConductorRunNotFound) {
    return {
      status: 404,
      code: "conductor_run_not_found",
      chat: "I couldn't find the build this change should attach to. Try again from the Website tab.",
    };
  }
  if (e instanceof BuildRetired) {
    return {
      status: 409,
      code: "build_retired",
      chat: "This app was retired when we upgraded the builder, so it's offline and I can't change it. Start a new build to get a fresh app.",
    };
  }
  if (e instanceof SitePreviewRestarting) {
    return {
      status: 409,
      code: "preview_restarting",
      chat: "This site's preview is restarting. Send your change again once the preview is back.",
    };
  }
  if (e instanceof UndoInProgress) {
    return {
      status: 409,
      code: "undo_in_progress",
      chat: "An undo is still running for this app. Wait for it to finish, then send your change again.",
    };
  }
  if (e instanceof DoubleBuildInFlight) {
    return {
      status: 409,
      code: "build_already_in_progress",
      chat: "Another build or change is already running for this workspace — I'll be able to start this once it finishes.",
    };
  }
  if (e instanceof TooManyBuildsToday) {
    return {
      status: 429,
      code: "daily_build_limit_reached",
      chat: "You've hit today's limit for app changes. This will be available again tomorrow.",
    };
  }
  if (e instanceof FreeEditsUsed) {
    return { status: 402, code: "free_edits_used", chat: e.message };
  }
  if (e instanceof InsufficientCreditsForBuild) {
    return {
      status: 402,
      code: "insufficient_credits_for_build",
      chat: refusalFor({
        kind: "credits_for_build",
        required_credits: e.required_credits,
        remaining_credits: e.remaining_credits,
        free_plan: e.free_plan,
        scope: e.scope,
      }).message,
    };
  }
  if (e instanceof ProvisionBudgetExceeded) {
    return {
      status: 402,
      code: "provision_budget_exceeded",
      chat: "This workspace is out of build budget, so I can't start the change.",
    };
  }
  if (e instanceof InsufficientCreditsForBuild) {
    return {
      status: 402,
      code: "insufficient_credits_for_build",
      chat: refusalFor({
        kind: "credits_for_build",
        required_credits: e.required_credits,
        remaining_credits: e.remaining_credits,
        free_plan: e.free_plan,
      }).message,
    };
  }
  if (e instanceof FleetHalted) {
    return {
      status: 503,
      code: "fleet_halted",
      chat: "App changes are paused right now. Nothing was started — try again shortly.",
    };
  }
  if (e instanceof AppFrozen) {
    return {
      status: 423,
      code: "app_frozen",
      chat: "This app is frozen, so I can't change it right now.",
    };
  }
  return {
    status: 500,
    code: "refine_product_failed",
    chat: "I couldn't start that change. Nothing was modified.",
  };
}

class PreviewSourcesUnavailable extends Error {
  constructor(cause: string) {
    super(`could not read preview sources: ${cause}`);
    this.name = "PreviewSourcesUnavailable";
  }
}

const BUILD_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function isTenantBuildSession(tenantId: string, runId: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id")
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new PreviewSourcesUnavailable(error.message);
  return !!data;
}

async function readPreviewSources(
  tenantId: string,
): Promise<{ marketingUrl: string | null; builtAppUrl: string | null }> {
  const sb = serviceClient();
  const [
    { data: tenant, error: tenantErr },
    { data: resources, error: resourcesErr },
  ] = await Promise.all([
    sb.from("tenants").select("product_url").eq("id", tenantId).maybeSingle(),
    sb
      .from("tenant_resources")
      .select("resource_kind,status,external_ref,updated_at")
      .eq("tenant_id", tenantId)
      .eq("resource_kind", "hosting")
      .order("updated_at", { ascending: false }),
  ]);

  if (tenantErr) throw new PreviewSourcesUnavailable(tenantErr.message);
  if (resourcesErr) throw new PreviewSourcesUnavailable(resourcesErr.message);

  const productUrl = (tenant?.product_url ?? {}) as Record<string, unknown>;
  const marketingUrl =
    typeof productUrl.marketing === "string" && productUrl.marketing
      ? productUrl.marketing
      : null;

  const hosting = (resources ?? []).find((r) => r.status === "ready");
  const ref = (hosting?.external_ref ?? {}) as Record<string, unknown>;
  const builtAppUrl = typeof ref.url === "string" && ref.url ? ref.url : null;

  return { marketingUrl, builtAppUrl };
}

const queuedChange = () => import("@/services/sites/queued-change");

export const websiteChatQueueDeps: { store: QueuedChangeStore | null; drain: (tenant_id: string) => Promise<unknown> } = {
  store: null,
  drain: async (tenant_id) => (await queuedChange()).drainQueuedSiteChange(tenant_id, await realDrainDeps()),
};

export async function realDrainDeps(): Promise<DrainDeps> {
  return {
    store: (await queuedChange()).realQueuedChangeStore,
    refine: (input) => refineProduct(input),
    tick: (conductor_run_id) => requestConductorTick(inngest, conductor_run_id),
    isBusy: (e) => e instanceof DoubleBuildInFlight || e instanceof NoProvisionedRepo || e instanceof SitePreviewRestarting || e instanceof UndoInProgress,
    notify: async (tenant_id, conductor_run_id, body) => (await import("@/services/build/build-ready-message")).postBuildChatNote({ tenant_id, conductor_run_id, body }),
    failureChat: (e) => {
      const mapped = mapRefineRejection(e);
      return mapped.status >= 500 ? null : mapped.chat;
    },
  };
}

export async function holdBusySiteChange(input: {
  tenant_id: string;
  site_id: string;
  conductor_run_id: string;
  message: string;
  user_id: string | null;
}): Promise<string | null> {
  const mod = await queuedChange();
  return mod.holdChangeWhileBuilding(input, {
    store: websiteChatQueueDeps.store ?? mod.realQueuedChangeStore,
    drain: websiteChatQueueDeps.drain,
  });
}

export async function postWebsiteChat(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { message?: unknown; confirm?: unknown; conductor_run_id?: unknown; scoped?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const confirm = body.confirm === true;
  const boundSessionId =
    typeof body.conductor_run_id === "string" && BUILD_SESSION_UUID_RE.test(body.conductor_run_id.trim())
      ? body.conductor_run_id.trim()
      : null;
  const sentSession = body.conductor_run_id !== undefined && body.conductor_run_id !== null && body.conductor_run_id !== "";

  if (!message) {
    res.status(400).json({
      error: { code: "bad_request", message: "message is required" },
    });
    return;
  }
  if (findSecretLikeTokens(message).length > 0) {
    res.status(422).json({ error: { code: "secret_in_chat", message: SECRET_IN_CHAT_MESSAGE, chat: SECRET_IN_CHAT_MESSAGE } });
    return;
  }

  if (appBuildScope(message) === "separate_app") {
    res.status(200).json({ route: "operator" });
    return;
  }

  void saveOwnerChatFacts(auth, message);

  const scoped = body.scoped === true && sentSession && !confirm;
  const strictEdit = isAppEditIntent(message);
  const looseSiteEdit = !strictEdit && sentSession && (scoped || isSiteChatEditIntent(message));
  if (!strictEdit && !looseSiteEdit) {
    res.status(200).json({ route: "operator" });
    return;
  }

  if (!(await requireTenantRole(auth, DISPATCH_ROLES, res))) return;

  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({
      error: {
        code: "product_builder_disabled",
        message: "Product builder is not enabled.",
        chat: "App changes aren't turned on for this workspace.",
      },
    });
    return;
  }

  if (
    message.length < (scoped ? MIN_SCOPED_MESSAGE_LEN : MIN_MESSAGE_LEN) ||
    message.length > (scoped ? MAX_SCOPED_MESSAGE : MAX_MESSAGE_LEN)
  ) {
    res.status(400).json({
      error: {
        code: "invalid_refine_message",
        message: `message must be ${MIN_MESSAGE_LEN}–${MAX_MESSAGE_LEN} chars`,
        chat: "I need a bit more detail to change the app. Describe what you want different in a sentence or two.",
      },
    });
    return;
  }

  if (sentSession && !boundSessionId) {
    res.status(400).json({
      error: {
        code: "invalid_build_session",
        message: "conductor_run_id must be a build id",
        chat: "I couldn't tell which app this change is for, so I haven't started anything. Reopen the app and try again.",
      },
    });
    return;
  }
  if (boundSessionId) {
    let owned: boolean;
    try {
      owned = await isTenantBuildSession(auth.tenant_id, boundSessionId);
    } catch (e) {
      await logEvent({
        level: "error",
        source: "website.chat",
        code: "website_chat_build_session_check_failed",
        tenant_id: auth.tenant_id,
        error: e,
      });
      res.status(503).json({
        error: {
          code: "build_session_check_failed",
          message: (e as Error).message,
          chat: "I couldn't check which app this is just now, so I haven't started anything. Try again in a moment.",
        },
      });
      return;
    }
    if (!owned) {
      res.status(404).json({
        error: {
          code: "build_session_not_found",
          message: "build session not found",
          chat: "I couldn't find this app in your workspace, so I haven't started anything. Open it again from your builds and retry.",
        },
      });
      return;
    }
  }

  let sources: { marketingUrl: string | null; builtAppUrl: string | null } = {
    marketingUrl: null,
    builtAppUrl: null,
  };
  let boundBuild = false;
  let boundSite = false;
  let boundSiteId: string | null = null;
  try {
    if (boundSessionId) {
      boundBuild = true;
      try {
        const site = await realRefineProductDeps.loadSiteForRun?.(auth.tenant_id, boundSessionId);
        boundSite = !!site;
        boundSiteId = site?.id ?? null;
      } catch (e) {
        throw e instanceof PreviewSourcesUnavailable
          ? e
          : new PreviewSourcesUnavailable((e as Error)?.message ?? String(e));
      }
    }
    if (!boundSite) {
      sources = await readPreviewSources(auth.tenant_id);
    }
  } catch (e) {
    await logEvent({
      level: "error",
      source: "website.chat",
      code: "website_chat_preview_sources_failed",
      tenant_id: auth.tenant_id,
      error: e,
    });
    res.status(503).json({
      error: {
        code: "preview_sources_unavailable",
        message: (e as Error).message,
        chat: "I couldn't check your app just now, so I haven't started anything. Try again in a moment.",
      },
    });
    return;
  }
  if (looseSiteEdit && !boundSite) {
    res.status(200).json({ route: "operator" });
    return;
  }

  const verdict: EditabilityVerdict = boundSite
    ? { editable: true }
    : deriveWebsiteEditability({ ...sources, boundBuild });
  if (!verdict.editable) {
    res.status(409).json({
      error: {
        code: "preview_not_editable",
        message: `Preview is not an editable Zavi-built app (${verdict.reason}).`,
        chat:
          verdict.reason === "previewing_own_site"
            ? "The site on the left is your own registered website, not an app I built, so I can't change it from here."
            : "There's no Zavi-built app for this workspace yet, so there's nothing for me to change.",
      },
    });
    return;
  }

  if (!boundSite) {
    res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
    return;
  }

  const note = isDestructiveDataEdit(message) ? DATA_DELETE_NOTE : null;

  if (!confirm) {
    const prompt = await appEditConfirmPrompt(auth.tenant_id, { site: boundSite });
    res.status(200).json({
      route: "app_edit",
      stage: "confirm",
      prompt: note ? `${note} ${prompt}` : prompt,
      ...(note ? { note } : {}),
    });
    return;
  }

  try {
    const cleanMessage = xmlEscapeContent(sanitizeFetchedContent(message));
    const result = await refineProduct({
      tenant_id: auth.tenant_id,
      message: cleanMessage,
      ...(boundBuild && boundSessionId ? { conductor_run_id: boundSessionId } : {}),
    });
    await requestConductorTick(inngest, result.conductor_run_id);
    res.status(200).json({
      route: "app_edit",
      stage: "dispatched",
      conductor_run_id: result.conductor_run_id,
      parent_conductor_run_id: result.parent_conductor_run_id,
      target: result.target,
      ...(result.stop_at_preview === true ? { stop_at_preview: true } : {}),
      ...(note ? { note } : {}),
    });
  } catch (e) {
    if ((e instanceof DoubleBuildInFlight || e instanceof NoProvisionedRepo) && boundSiteId && boundSessionId) {
      const queued = await holdBusySiteChange({
        tenant_id: auth.tenant_id,
        site_id: boundSiteId,
        conductor_run_id: boundSessionId,
        message: xmlEscapeContent(sanitizeFetchedContent(message)),
        user_id: auth.user_id ?? null,
      });
      if (queued) {
        res.status(200).json({ route: "app_edit", stage: "queued", chat: queued, ...(note ? { note } : {}) });
        return;
      }
    }
    const mapped = mapRefineRejection(e);
    if (mapped.status >= 500) {
      await logEvent({
        level: "error",
        source: "website.chat",
        code: "website_chat_refine_failed",
        tenant_id: auth.tenant_id,
        error: e,
      });
    }
    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: (e as Error).message,
        chat: mapped.chat,
        ...(mapped.action ? { action: mapped.action } : {}),
      },
    });
  }
}
