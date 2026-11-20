
import type { BrowserToolCtx, DaemonOp, DaemonResult } from "./types";
import { pinnedEngine, resolveEngine, type BrowserEngine } from "./engine-policy";
import { sandboxBackend } from "./sandbox-backend";
import {
  extensionBackend,
  clearExtensionRunState,
  beginExtensionTaskState,
  navLeavesPinnedSite,
  _resetExtensionState,
} from "./extension-backend";
import { isExtensionBrowserControlEnabled } from "@/services/extension/control-flag";
import {
  runWithMoneyGate,
  moneyGateDeps,
  clearMoneyGateRunState,
  _resetMoneyGateState,
} from "./extension-money-gate";
import { navLooksLikeMoney } from "./money-step";
import {
  anchorBackend,
  getBrowserActionEmitter,
  BROWSER_ACTION_DECISION_CLASS,
} from "./anchor-backend";
import {
  classifyBrowserOp,
  navTargetUrl,
  navLooksSideEffecting,
  buildBrowserActionBody,
  buildBrowserActionEvidence,
} from "./browser-action-gate";
import {
  isAutoExecuteBrowserAgent,
  isInlineAutoExecutableOp,
} from "./browser-auto-execute-policy";
import { logEvent } from "@/services/logging/logEvent";

export interface BrowserBackend {
  runOp(ctx: BrowserToolCtx, op: DaemonOp): Promise<DaemonResult>;
}

const BACKENDS: Record<BrowserEngine, BrowserBackend> = {
  sandbox: sandboxBackend,
  anchor: anchorBackend,
  extension: extensionBackend,
};

const runEngine = new Map<string, BrowserEngine>();

const runOrigin = new Map<string, string>();

const runFirstOrigin = new Map<string, string>();

const runWriteCount = new Map<string, number>();

const MAX_INLINE_WRITES_PER_RUN = 20;

const runScreenshotArtifactCount = new Map<string, number>();
const MAX_SCREENSHOT_ARTIFACTS_PER_RUN = 5;

export function claimScreenshotArtifactSlot(run_id: string): boolean {
  const n = (runScreenshotArtifactCount.get(run_id) ?? 0) + 1;
  if (n > MAX_SCREENSHOT_ARTIFACTS_PER_RUN) return false;
  runScreenshotArtifactCount.set(run_id, n);
  return true;
}

const MAX_INLINE_WRITES_PER_RUN_STAGING_PINNED = 40;

export const MAX_EXTENSION_WRITES_PER_RUN = 60;

function auditOrigin(u?: string): string {
  if (!u) return "";
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

export function _resetRunEngineCache(): void {
  runEngine.clear();
  runOrigin.clear();
  runFirstOrigin.clear();
  runWriteCount.clear();
  runScreenshotArtifactCount.clear();
  _resetExtensionState();
  _resetMoneyGateState();
}

export function _clearRunBrowserState(run_id: string): void {
  runEngine.delete(run_id);
  runOrigin.delete(run_id);
  runFirstOrigin.delete(run_id);
  runWriteCount.delete(run_id);
  runScreenshotArtifactCount.delete(run_id);
  clearExtensionRunState(run_id);
  clearMoneyGateRunState(run_id);
}

export function beginExtensionTask(run_id: string): void {
  runWriteCount.delete(run_id);
  beginExtensionTaskState(run_id);
  clearMoneyGateRunState(run_id);
}

function noteFirstOrigin(run_id: string, url?: string): void {
  if (!url || runFirstOrigin.has(run_id)) return;
  const o = auditOrigin(url);
  if (o) runFirstOrigin.set(run_id, o);
}

function tenantHostileSuffixes(_ctx: BrowserToolCtx): readonly string[] {
  return [];
}

export async function runBrowserOp(
  ctx: BrowserToolCtx,
  op: DaemonOp,
): Promise<DaemonResult> {
  if (ctx.engine) {
    if (!ctx.read_only) {
      return {
        ok: false,
        error_code: "browser_engine_pin_requires_read_only",
        error_message: "An engine-pinned browser session must be read_only.",
      };
    }
    if (classifyBrowserOp(op) === "write") {
      return {
        ok: false,
        error_code: "browser_write_blocked_read_only",
        error_message: `Browser write \`${op.op}\` is blocked: this browser session is read-only.`,
      };
    }
    if (op.op === "nav" && navLooksSideEffecting(op.url)) {
      await logEvent({
        level: "warn",
        source: "browser.nav_side_effect_blocked",
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        meta: {
          agent_slug: ctx.agent_slug,
          run_id_ref: ctx.run_id,
          engine: ctx.engine,
          op: op.op,
          origin: auditOrigin(op.url),
        },
      });
      return {
        ok: false,
        error_code: "browser_nav_side_effect_blocked",
        error_message:
          `Navigation to \`${op.url}\` is blocked: the URL looks like a ` +
          `side-effecting action link (confirm / unsubscribe / delete / approve / ` +
          `pay). Read the page that links to it and report instead.`,
      };
    }
    return BACKENDS[ctx.engine].runOp(ctx, op);
  }

  const isBrowserOperatorSlug = isAutoExecuteBrowserAgent(ctx.agent_slug);
  const isAutoExecute = isBrowserOperatorSlug && !ctx.read_only;
  const opInlineAutoExecutable = isAutoExecute && isInlineAutoExecutableOp(op.op);

  if (ctx.read_only && classifyBrowserOp(op) === "write") {
    return {
      ok: false,
      error_code: "browser_write_blocked_read_only",
      error_message:
        `Browser write \`${op.op}\` is blocked: this browser-operator run is ` +
        `operating in read_only mode (dispatched by qa-weekly-execute worker). ` +
        `Write ops (click / fill) are not permitted in scheduled QA observation ` +
        `runs — they are only allowed in interactive (non-scheduled) runs. ` +
        `trigger=qa-weekly-execute; source=qa_weekly_execute.`,
    };
  }
  if (pinnedEngine(ctx) === "extension" || runEngine.get(ctx.run_id) === "extension") {
    return runExtensionEngineOp(ctx, op);
  }

  let engine = runEngine.get(ctx.run_id);
  if (op.op === "nav") {
    engine = resolveEngine(op.url, tenantHostileSuffixes(ctx));
    runOrigin.set(ctx.run_id, op.url);
    noteFirstOrigin(ctx.run_id, op.url);
    if (isBrowserOperatorSlug && engine === "sandbox") {
      engine = "anchor";
    }
    runEngine.set(ctx.run_id, engine);
  } else if (!engine) {
    engine = resolveEngine(ctx.staging_origin, tenantHostileSuffixes(ctx));
    if (isBrowserOperatorSlug && engine === "sandbox") {
      engine = "anchor";
    }
    if (ctx.staging_origin) {
      runOrigin.set(ctx.run_id, ctx.staging_origin);
      noteFirstOrigin(ctx.run_id, ctx.staging_origin);
    }
    runEngine.set(ctx.run_id, engine);
  }

  if (
    op.op === "nav" &&
    !isAutoExecute &&
    !ctx.staging_origin &&
    navLooksSideEffecting(op.url)
  ) {
    await logEvent({
      level: "warn",
      source: "browser.nav_side_effect_blocked",
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      meta: {
        agent_slug: ctx.agent_slug,
        run_id_ref: ctx.run_id,
        engine,
        op: op.op,
        origin: auditOrigin(op.url),
      },
    });
    return {
      ok: false,
      error_code: "browser_nav_side_effect_blocked",
      error_message:
        `Navigation to \`${op.url}\` is blocked: the URL looks like a ` +
        `side-effecting action link (confirm / unsubscribe / delete / approve / ` +
        `pay). A non-interactive browser read must NOT auto-navigate to an ` +
        `action link — read the page and report what you found instead of ` +
        `firing the action.`,
    };
  }

  if (classifyBrowserOp(op) === "write" && !opInlineAutoExecutable) {
    if (engine === "sandbox") {
      return {
        ok: false,
        error_code: "browser_write_sandbox_unsupported",
        error_message:
          `Browser write \`${op.op}\` resolved to the sandbox engine, which has ` +
          `no approved-replay path (executeApprovedBrowserAction is Anchor-only). ` +
          `Sandbox-routed browser writes are not yet supported — gating it would ` +
          `propose a decision that can never be safely executed. Reads/navigation ` +
          `run inline on the sandbox engine as normal.`,
      };
    }

    const body = buildBrowserActionBody(op);
    const bodyWithEvidence: Record<string, unknown> = {
      ...body,
      decision_evidence: buildBrowserActionEvidence(body),
    };
    try {
      const decision_id = await getBrowserActionEmitter().emit({
        tenant_id: ctx.tenant_id,
        agent_run_id: ctx.run_id,
        decision_class: BROWSER_ACTION_DECISION_CLASS,
        body: bodyWithEvidence,
      });
      return {
        ok: false,
        error_code: "browser_action_pending_approval",
        error_message:
          `Browser write \`${body.op}\` requires approval before it runs. ` +
          `Proposed for review in /approvals (decision ${decision_id}); it ` +
          `executes only after an operator approves. Reads/navigation run ` +
          `inline — only page-mutating actions are gated (prompt-injection ` +
          `containment, Bundle B item B-2).`,
      };
    } catch (e) {
      return {
        ok: false,
        error_code: "browser_action_gate_error",
        error_message: `failed to queue browser write for approval: ${(e as Error).message}`,
      };
    }
  }

  if (isAutoExecute && classifyBrowserOp(op) === "write") {
    const writeCap = ctx.staging_origin
      ? MAX_INLINE_WRITES_PER_RUN_STAGING_PINNED
      : MAX_INLINE_WRITES_PER_RUN;
    const priorWrites = runWriteCount.get(ctx.run_id) ?? 0;
    if (priorWrites + 1 > writeCap) {
      return {
        ok: false,
        error_code: "browser_write_cap_exceeded",
        error_message:
          `Browser write \`${op.op}\` exceeds the per-run inline write cap ` +
          `(${writeCap}). A real interactive flow stays well ` +
          `under this; tripping it usually means a loop. The run is halted ` +
          `before this write executes.`,
      };
    }

    {
      const stagingPin = ctx.staging_origin
        ? auditOrigin(ctx.staging_origin) || ctx.staging_origin
        : "";
      const pinnedOrigin = stagingPin || runFirstOrigin.get(ctx.run_id) || "";
      if (!pinnedOrigin) {
        await logEvent({
          level: "warn",
          source: "browser.write_blocked_no_origin",
          tenant_id: ctx.tenant_id,
          run_id: ctx.run_id,
          meta: {
            agent_slug: ctx.agent_slug,
            run_id_ref: ctx.run_id,
            engine,
            op: op.op,
          },
        });
        return {
          ok: false,
          error_code: "browser_write_blocked_no_origin",
          error_message:
            `Browser write \`${op.op}\` is blocked: no origin has been ` +
            `established for this run (navigate to the target site first). ` +
            `Writes are pinned to the run's first-navigated origin.`,
        };
      }
      const originRe = `^${pinnedOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/?#]|$)`;
      let onOrigin = false;
      try {
        const probe = await BACKENDS[engine].runOp(ctx, {
          op: "assert_url",
          expected: originRe,
        });
        onOrigin = probe.ok;
      } catch {
        onOrigin = false;
      }
      if (!onOrigin) {
        await logEvent({
          level: "warn",
          source: "browser.write_blocked_off_origin",
          tenant_id: ctx.tenant_id,
          run_id: ctx.run_id,
          meta: {
            agent_slug: ctx.agent_slug,
            run_id_ref: ctx.run_id,
            engine,
            op: op.op,
            origin: pinnedOrigin,
          },
        });
        return {
          ok: false,
          error_code: "browser_write_blocked_off_origin",
          error_message:
            `Browser write \`${op.op}\` is blocked: the current page is not on ` +
            `the pinned origin (${pinnedOrigin}). A click or redirect moved the ` +
            `browser off the origin this run started on — writes are only ` +
            `permitted on that origin. Navigate back to continue, or report ` +
            `blocked with blocked_kind "off_origin".`,
        };
      }
    }

    if (engine === "sandbox") {
      engine = "anchor";
      runEngine.set(ctx.run_id, engine);
      await logEvent({
        level: "warn",
        source: "browser.promote_to_anchor",
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        meta: {
          agent_slug: ctx.agent_slug,
          run_id_ref: ctx.run_id,
          engine,
          op: op.op,
          origin: auditOrigin(runOrigin.get(ctx.run_id)),
        },
      });
      const lastOrigin = runOrigin.get(ctx.run_id);
      if (lastOrigin) {
        await BACKENDS.anchor.runOp(ctx, { op: "nav", url: lastOrigin });
      }
    }

    runWriteCount.set(ctx.run_id, priorWrites + 1);
    await logEvent({
      level: "info",
      source: "browser.inline_write",
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      meta: {
        agent_slug: ctx.agent_slug,
        run_id_ref: ctx.run_id,
        engine,
        op: op.op,
        origin: auditOrigin(runOrigin.get(ctx.run_id)),
        read_only: ctx.read_only ?? false,
        initiated_by_user: ctx.user_id,
      },
    });
    return BACKENDS[engine].runOp(ctx, op);
  }

  return BACKENDS[engine].runOp(ctx, op);
}

export async function extensionWritesAutoExecute(ctx: BrowserToolCtx): Promise<boolean> {
  if (!ctx.user_id || !ctx.extension?.panel_session_id) return false;
  return isExtensionBrowserControlEnabled();
}

async function runExtensionEngineOp(
  ctx: BrowserToolCtx,
  op: DaemonOp,
): Promise<DaemonResult> {
  runEngine.set(ctx.run_id, "extension");
  if (!ctx.extension || !ctx.user_id) {
    return {
      ok: false,
      error_code: "no_panel",
      error_message: "This run has no Zavi panel attached to a tab.",
    };
  }

  if (classifyBrowserOp(op) === "write") {
    if (!(await extensionWritesAutoExecute(ctx))) {
      return {
        ok: false,
        error_code: "browser_write_extension_disabled",
        error_message:
          `Browser write \`${op.op}\` was not run: Zavi is not allowed to click or ` +
          `type in this tab yet. It can still read the page.`,
      };
    }
    const priorWrites = runWriteCount.get(ctx.run_id) ?? 0;
    if (priorWrites + 1 > MAX_EXTENSION_WRITES_PER_RUN) {
      return {
        ok: false,
        error_code: "browser_write_cap_exceeded",
        error_message:
          `Browser write \`${op.op}\` exceeds the per-task write cap ` +
          `(${MAX_EXTENSION_WRITES_PER_RUN}). The task stops before this step.`,
      };
    }
    runWriteCount.set(ctx.run_id, priorWrites + 1);
    await logEvent({
      level: "info",
      source: "browser.inline_write",
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      meta: {
        agent_slug: ctx.agent_slug,
        run_id_ref: ctx.run_id,
        engine: "extension",
        op: op.op,
        initiated_by_user: ctx.user_id,
      },
    });
    return runWithMoneyGate(ctx, op, await moneyGateDeps());
  }
  const navUrl = navTargetUrl(op);
  if (navUrl !== null && navLooksSideEffecting(navUrl) && !(await extensionWritesAutoExecute(ctx))) {
    return {
      ok: false,
      error_code: "browser_nav_side_effect_blocked",
      error_message:
        `Navigation to \`${navUrl}\` is blocked: the URL looks like an action ` +
        `link, and Zavi is not allowed to act in this tab yet.`,
    };
  } else if (navUrl !== null && navLooksLikeMoney(navUrl) && !navLeavesPinnedSite(ctx.run_id, navUrl)) {
    return runWithMoneyGate(ctx, op, await moneyGateDeps());
  }

  return BACKENDS.extension.runOp(ctx, op);
}
