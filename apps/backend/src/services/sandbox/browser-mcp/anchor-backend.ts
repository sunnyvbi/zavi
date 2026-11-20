
import type { BrowserBackend } from "./backend";
import { browserSessionKey, type BrowserToolCtx, type DaemonOp, type DaemonResult } from "./types";
import {
  openBrowserSession,
  closeBrowserSession,
  setBrowserSessionProviderId,
} from "./browser-sessions";
import { createRestAnchorClient } from "./anchor-rest-client";
import { getPickerOverlayInjector } from "./picker-overlay";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { validateDecisionEvidenceInBody } from "@/services/agents/decision-evidence";
import { isAutoExecuteBrowserAgent } from "./browser-auto-execute-policy";
import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";
import {
  getConnectedSocialAccount,
  type ConnectedSocialAccount,
} from "./social-connections";
import { maybeInjectSocialLogin } from "./social-login";

export interface AnchorSession {
  id: string;
  cdp_url?: string;
  live_view_url?: string;
  network_guard?: boolean;
}

export interface AnchorClient {
  createSession(opts: {
    apiKey: string;
    profileId?: string;
    headful?: boolean;
    oneTimeLiveViewUrl?: boolean;
    viewport?: { width: number; height: number };
    networkGuard?: boolean;
  }): Promise<AnchorSession>;
  runAction(opts: {
    apiKey: string;
    session: AnchorSession;
    op: DaemonOp;
  }): Promise<DaemonResult>;
  closeSession(opts: { apiKey: string; session: AnchorSession }): Promise<void>;
}

const sessionByRun = new Map<string, AnchorSession>();
const dbSessionByRun = new Map<string, string>();
const sessionOpenedAt = new Map<string, number>();

export function _resetAnchorSessionCache(): void {
  sessionByRun.clear();
  dbSessionByRun.clear();
  sessionOpenedAt.clear();
}

let clientImpl: AnchorClient | null = null;
let defaultClient: AnchorClient | null = null;
export function _setAnchorClient(c: AnchorClient | null): void {
  clientImpl = c;
}

function getClient(): AnchorClient {
  if (clientImpl) return clientImpl;
  if (!defaultClient) defaultClient = createRestAnchorClient();
  return defaultClient;
}

export interface BrowserSessionTracker {
  open(args: {
    tenant_id: string;
    run_id: string | null;
    origin?: string;
  }): Promise<string>;
  setProviderId?(args: {
    session_id: string;
    provider_session_id: string;
  }): Promise<void>;
  close(args: { session_id: string; reason?: string; browser_seconds?: number }): Promise<void>;
}

let trackerImpl: BrowserSessionTracker | null = null;
export function _setBrowserSessionTracker(t: BrowserSessionTracker | null): void {
  trackerImpl = t;
}

function getTracker(): BrowserSessionTracker {
  if (trackerImpl) return trackerImpl;
  return {
    async open(a) {
      return openBrowserSession({
        tenant_id: a.tenant_id,
        run_id: a.run_id,
        engine: "anchor",
        origin: a.origin,
      });
    },
    async setProviderId(a) {
      return setBrowserSessionProviderId({
        session_id: a.session_id,
        provider_session_id: a.provider_session_id,
      });
    },
    async close(a) {
      return closeBrowserSession({
        session_id: a.session_id,
        reason: a.reason,
        browser_seconds: a.browser_seconds,
      });
    },
  };
}

export interface BrowserActionDecisionEmitter {
  emit(args: {
    tenant_id: string;
    agent_run_id: string;
    decision_class: string;
    body: Record<string, unknown>;
  }): Promise<string>;
}

let emitterImpl: BrowserActionDecisionEmitter | null = null;
export function _setBrowserActionEmitter(e: BrowserActionDecisionEmitter | null): void {
  emitterImpl = e;
}

export function getBrowserActionEmitter(): BrowserActionDecisionEmitter {
  if (emitterImpl) return emitterImpl;
  return {
    async emit(a) {
      validateDecisionEvidenceInBody(a.body, {
        decision_class: a.decision_class,
      });
      const { data, error } = await serviceClient().rpc("emit_decision", {
        p_tenant_id: a.tenant_id,
        p_agent_run_id: a.agent_run_id,
        p_decision_class: a.decision_class,
        p_body: a.body as object,
      });
      if (error) {
        throw new Error(
          `emit_decision failed (${a.decision_class}): ${error.message}`,
        );
      }
      return data as string;
    },
  };
}

export const BROWSER_ACTION_DECISION_CLASS = "browser.action";

async function resolveSocialLoginPlan(
  ctx: BrowserToolCtx,
  origin?: string,
): Promise<{
  resumeProfileId?: string;
  needsFirstLogin: boolean;
  account: ConnectedSocialAccount | null;
}> {
  const NO_LOGIN = { needsFirstLogin: false, account: null } as const;
  if (ctx.logged_out) return NO_LOGIN;
  try {
    if (!isAutoExecuteBrowserAgent(ctx.agent_slug)) return NO_LOGIN;
    if (!(await isSocialPublishEnabled())) return NO_LOGIN;
    const account = await getConnectedSocialAccount(
      ctx.tenant_id,
      origin,
      ctx.user_id,
    );
    if (!account) return NO_LOGIN;
    if (account.anchor_profile_id) {
      return {
        resumeProfileId: account.anchor_profile_id,
        needsFirstLogin: false,
        account,
      };
    }
    return { needsFirstLogin: true, account };
  } catch {
    return NO_LOGIN;
  }
}

export const anchorBackend: BrowserBackend = {
  async runOp(ctx: BrowserToolCtx, op: DaemonOp): Promise<DaemonResult> {
    const apiKey = process.env.ANCHOR_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error_code: "anchor_not_configured",
        error_message:
          "ANCHOR_API_KEY not set — Anchor backend is disabled. Add the key to " +
          "Secrets Manager (praxis-envprod-1) + restart the container to enable " +
          "hostile-site (IG/LinkedIn/TikTok) routing.",
      };
    }

    const client = getClient();
    const key = browserSessionKey(ctx);
    let session = sessionByRun.get(key);
    if (!session) {
      const sessionOrigin = op.op === "nav" ? op.url : ctx.staging_origin;
      let dbSessionId: string;
      try {
        dbSessionId = await getTracker().open({
          tenant_id: ctx.tenant_id,
          run_id: ctx.run_id,
          origin: sessionOrigin,
        });
      } catch (e) {
        return {
          ok: false,
          error_code: "anchor_budget_exceeded",
          error_message: (e as Error).message,
        };
      }

      const login = await resolveSocialLoginPlan(ctx, sessionOrigin);
      try {
        session = await client.createSession({
          apiKey,
          profileId: ctx.logged_out ? undefined : login.resumeProfileId,
          ...(ctx.network_guard ? { networkGuard: true } : {}),
        });
      } catch (e) {
        await getTracker()
          .close({ session_id: dbSessionId, reason: "create_failed" })
          .catch(() => {});
        return {
          ok: false,
          error_code: "anchor_create_failed",
          error_message: (e as Error).message,
        };
      }
      sessionByRun.set(key, session);
      dbSessionByRun.set(key, dbSessionId);
      sessionOpenedAt.set(key, Date.now());

      await getTracker()
        .setProviderId?.({ session_id: dbSessionId, provider_session_id: session.id })
        .catch((e) =>
          logEvent({
            level: "warn",
            source: "browser.provider_id_stamp_failed",
            run_id: ctx.run_id,
            error: e,
            meta: { run_id_ref: ctx.run_id, engine: "anchor" },
          }),
        );

      if (login.needsFirstLogin) {
        const injected = await maybeInjectSocialLogin({
          ctx,
          origin: sessionOrigin,
          session,
          client,
          apiKey,
          account: login.account,
        });
        if (injected.result && !injected.result.ok) return injected.result;
      }
    }
    return client.runAction({ apiKey, session, op });
  },
};

export async function executeApprovedBrowserAction(args: {
  tenant_id: string;
  replay_run_id: string | null;
  op: DaemonOp;
}): Promise<DaemonResult> {
  const apiKey = process.env.ANCHOR_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error_code: "anchor_not_configured",
      error_message:
        "ANCHOR_API_KEY not set — cannot execute the approved browser action.",
    };
  }
  const client = getClient();
  let dbSessionId: string;
  try {
    dbSessionId = await getTracker().open({
      tenant_id: args.tenant_id,
      run_id: args.replay_run_id,
      origin: args.op.op === "nav" ? args.op.url : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      error_code: "anchor_budget_exceeded",
      error_message: (e as Error).message,
    };
  }
  const session = await client.createSession({ apiKey });
  await getTracker()
    .setProviderId?.({ session_id: dbSessionId, provider_session_id: session.id })
    .catch((e) =>
      logEvent({
        level: "warn",
        source: "browser.provider_id_stamp_failed",
        error: e,
        meta: { engine: "anchor", path: "approved_replay" },
      }),
    );
  try {
    return await client.runAction({ apiKey, session, op: args.op });
  } finally {
    await client.closeSession({ apiKey, session }).catch(() => {
    });
    await getTracker()
      .close({ session_id: dbSessionId, reason: "browser_action_replay" })
      .catch(() => {
      });
  }
}

const PREVIEW_VIEWPORT = { width: 1600, height: 1000 };

export async function openSitePreviewSession(args: {
  tenant_id: string;
  url: string;
}): Promise<
  | { ok: true; session_id: string; live_view_url: string; cdp_url?: string }
  | { ok: false; error_code: string; error_message: string }
> {
  const apiKey = process.env.ANCHOR_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error_code: "anchor_not_configured",
      error_message:
        "ANCHOR_API_KEY not set — live site preview is disabled. Add the key to " +
        "Secrets Manager (praxis-envprod-1) + restart the container to enable it.",
    };
  }

  const client = getClient();

  let dbSessionId: string;
  try {
    dbSessionId = await getTracker().open({
      tenant_id: args.tenant_id,
      run_id: null,
      origin: args.url,
    });
  } catch (e) {
    return {
      ok: false,
      error_code: "anchor_budget_exceeded",
      error_message: (e as Error).message,
    };
  }

  let session: AnchorSession;
  try {
    session = await client.createSession({
      apiKey,
      headful: true,
      oneTimeLiveViewUrl: false,
      viewport: PREVIEW_VIEWPORT,
    });
  } catch (e) {
    await getTracker()
      .close({ session_id: dbSessionId, reason: "preview_create_failed" })
      .catch(() => {
      });
    return {
      ok: false,
      error_code: "anchor_create_failed",
      error_message: (e as Error).message,
    };
  }

  await getTracker()
    .setProviderId?.({ session_id: dbSessionId, provider_session_id: session.id })
    .catch((e) =>
      logEvent({
        level: "warn",
        source: "browser.provider_id_stamp_failed",
        error: e,
        meta: { engine: "anchor", path: "site_preview" },
      }),
    );

  const nav = await client.runAction({
    apiKey,
    session,
    op: { op: "nav", url: args.url },
  });
  if (!nav.ok) {
    await client.closeSession({ apiKey, session }).catch(() => {
    });
    await getTracker()
      .close({ session_id: dbSessionId, reason: "preview_nav_failed" })
      .catch(() => {
      });
    return {
      ok: false,
      error_code: nav.error_code ?? "preview_nav_failed",
      error_message: nav.error_message ?? "navigation failed",
    };
  }

  const liveViewUrl = session.live_view_url;
  if (!liveViewUrl) {
    await client.closeSession({ apiKey, session }).catch(() => {
    });
    await getTracker()
      .close({ session_id: dbSessionId, reason: "preview_no_live_view" })
      .catch(() => {
      });
    return {
      ok: false,
      error_code: "no_live_view_url",
      error_message: "Anchor returned no live_view_url for the headful session.",
    };
  }

  if (session.cdp_url) {
    await getPickerOverlayInjector()
      .inject({ cdpUrl: session.cdp_url })
      .catch((e) =>
        logEvent({
          level: "warn",
          source: "browser.picker_overlay_inject_failed",
          error: e,
          meta: { engine: "anchor", path: "site_preview" },
        }),
      );
  }

  return {
    ok: true,
    session_id: dbSessionId,
    live_view_url: liveViewUrl,
    cdp_url: session.cdp_url,
  };
}

export async function closeAnchorRun(
  run_id: string,
  reason?: string,
): Promise<{ browser_seconds: number; opened: boolean }> {
  const apiKey = process.env.ANCHOR_API_KEY;
  const dbId = dbSessionByRun.get(run_id);
  const session = sessionByRun.get(run_id);
  const openedAt = sessionOpenedAt.get(run_id);
  const browser_seconds =
    openedAt !== undefined ? Math.max(1, Math.ceil((Date.now() - openedAt) / 1000)) : 0;
  let remoteClosed = !session;
  if (session && apiKey) {
    try {
      await getClient().closeSession({ apiKey, session });
      remoteClosed = true;
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "browser.session_close_failed",
        run_id,
        error: e instanceof Error ? e : new Error(String(e)),
        meta: { run_id_ref: run_id, engine: "anchor" },
      }).catch(() => {});
    }
  }
  if (!remoteClosed) return { browser_seconds, opened: !!session };
  if (dbId) {
    await getTracker()
      .close({ session_id: dbId, reason, browser_seconds })
      .catch((e) =>
        logEvent({
          level: "warn",
          source: "browser.session_row_close_failed",
          run_id,
          error: e,
          meta: { run_id_ref: run_id, engine: "anchor" },
        }),
      );
  }
  sessionByRun.delete(run_id);
  dbSessionByRun.delete(run_id);
  sessionOpenedAt.delete(run_id);
  return { browser_seconds, opened: !!session };
}
