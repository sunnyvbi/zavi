
import type { BrowserBackend } from "./backend";
import type { BrowserToolCtx, DaemonOp, DaemonResult } from "./types";
import { classifyBrowserOp, navLooksSideEffecting, navTargetUrl } from "./browser-action-gate";
import { registrableSite } from "./extension-site";
import {
  awaitOpResult,
  enqueueOp,
  expireHeldOp,
  releaseHeldOp,
} from "@/services/extension/browser-ops";
import { isExtensionBrowserControlEnabled } from "@/services/extension/control-flag";

export const OFF_SITE = "off_site";

const runSite = new Map<string, string>();
const runHalted = new Map<string, string>();
const runSeq = new Map<string, number>();

export function clearExtensionRunState(run_id: string): void {
  runSite.delete(run_id);
  runHalted.delete(run_id);
  runSeq.delete(run_id);
}

export function beginExtensionTaskState(run_id: string): void {
  runSite.delete(run_id);
  runHalted.delete(run_id);
}

export function nextExtensionSeq(run_id: string): number {
  const seq = (runSeq.get(run_id) ?? 0) + 1;
  runSeq.set(run_id, seq);
  return seq;
}

export function pinnedSiteOf(run_id: string): string | null {
  return runSite.get(run_id) ?? null;
}

export function _resetExtensionState(): void {
  runSite.clear();
  runHalted.clear();
  runSeq.clear();
}

export function navLeavesPinnedSite(run_id: string, url: string): boolean {
  const pinned = runSite.get(run_id);
  return !!pinned && registrableSite(url) !== pinned;
}

export function _pinnedSite(run_id: string): string | undefined {
  return runSite.get(run_id);
}

function fail(error_code: string, error_message: string): DaemonResult {
  return { ok: false, error_code, error_message };
}

type Sent = { outcome: DaemonResult; top_url: string | null };

function topUrlOf(result: unknown): string | null {
  const v = (result as { top_url?: unknown } | null)?.top_url;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function shortStr(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function enqueueRefused(reason: "no_panel" | "tab_mismatch"): DaemonResult {
  return fail(
    reason,
    reason === "no_panel"
      ? "The Zavi panel for this tab is closed or no longer connected."
      : "The Zavi panel is attached to a different tab.",
  );
}

export const HELD_OP_EXPIRES_MS = 11 * 60_000;

export async function holdExtensionOp(
  ctx: BrowserToolCtx,
  op: DaemonOp,
): Promise<{ ok: true; op_id: string } | { ok: false; outcome: DaemonResult }> {
  const ext = ctx.extension;
  if (!ext || !ctx.user_id) {
    return { ok: false, outcome: fail("no_panel", "This run has no Zavi panel attached to a tab.") };
  }
  const seq = (runSeq.get(ctx.run_id) ?? 0) + 1;
  runSeq.set(ctx.run_id, seq);
  const held = await enqueueOp({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    run_id: ctx.run_id,
    session_id: ext.panel_session_id,
    tab_id: ext.tab_id,
    seq,
    op: op as unknown as Record<string, unknown>,
    is_write: classifyBrowserOp(op) === "write",
    status: "awaiting_confirm",
    expires_in_ms: HELD_OP_EXPIRES_MS,
  });
  return held.ok ? { ok: true, op_id: held.op_id } : { ok: false, outcome: enqueueRefused(held.reason) };
}

async function sendOp(ctx: BrowserToolCtx, op: DaemonOp, heldOpId?: string): Promise<Sent> {
  const ext = ctx.extension;
  if (!ext || !ctx.user_id) {
    return {
      outcome: fail("no_panel", "This run has no Zavi panel attached to a tab."),
      top_url: null,
    };
  }

  let op_id: string;
  if (heldOpId) {
    const released = await releaseHeldOp({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      op_id: heldOpId,
    });
    if (!released) {
      return {
        outcome: fail("extension_op_expired", `The confirmed \`${op.op}\` is no longer waiting. It did not run.`),
        top_url: null,
      };
    }
    op_id = heldOpId;
  } else {
    const seq = (runSeq.get(ctx.run_id) ?? 0) + 1;
    runSeq.set(ctx.run_id, seq);

    const queued = await enqueueOp({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      run_id: ctx.run_id,
      session_id: ext.panel_session_id,
      tab_id: ext.tab_id,
      seq,
      op: op as unknown as Record<string, unknown>,
      is_write: classifyBrowserOp(op) === "write",
    });
    if (!queued.ok) return { outcome: enqueueRefused(queued.reason), top_url: null };
    op_id = queued.op_id;
  }

  const got = await awaitOpResult({ tenant_id: ctx.tenant_id, op_id });
  switch (got.status) {
    case "done":
      return { outcome: { ok: true, result: got.result }, top_url: topUrlOf(got.result) };
    case "failed": {
      const r = got.result as { error_code?: unknown; error_message?: unknown } | null;
      return {
        outcome: fail(
          shortStr(r?.error_code, 64) ?? "extension_op_failed",
          shortStr(r?.error_message, 500) ?? `The panel could not run \`${op.op}\`.`,
        ),
        top_url: topUrlOf(got.result),
      };
    }
    case "unknown":
      return {
        outcome: fail(
          "extension_op_unknown",
          `The panel took \`${op.op}\` but no result came back. It may or may not have run; it is not sent again.`,
        ),
        top_url: null,
      };
    case "expired":
      return {
        outcome: fail(
          "extension_op_expired",
          `The panel did not pick up \`${op.op}\` in time. It did not run.`,
        ),
        top_url: null,
      };
    default:
      return {
        outcome: fail("extension_op_lost", `The op record for \`${op.op}\` is gone.`),
        top_url: null,
      };
  }
}

function halt(run_id: string, pinned: string, seen: string | null): DaemonResult {
  runHalted.set(run_id, OFF_SITE);
  return fail(
    OFF_SITE,
    `The tab left ${pinned}${seen ? ` (now on ${seen})` : ""}. This task is limited to the ` +
      `site it started on, so it has stopped. No further steps will run.`,
  );
}

async function checkWhereTabIs(
  ctx: BrowserToolCtx,
  op: DaemonOp,
  isWrite: boolean,
): Promise<DaemonResult | null> {
  const probe = await sendOp(ctx, { op: "assert_url", expected: "" });
  if (!probe.top_url) {
    return probe.outcome.ok
      ? fail("site_unknown", "The panel did not report which page the tab is on.")
      : probe.outcome;
  }
  const seen = registrableSite(probe.top_url);
  const pinned = runSite.get(ctx.run_id);
  if (pinned) {
    return seen === pinned ? null : halt(ctx.run_id, pinned, seen);
  }
  if (seen) {
    runSite.set(ctx.run_id, seen);
    return null;
  }
  const navUrl = navTargetUrl(op);
  if (navUrl !== null) {
    const target = registrableSite(navUrl);
    if (target) runSite.set(ctx.run_id, target);
    return null;
  }
  return isWrite
    ? fail("site_unknown", "The tab is not on a website, so Zavi will not click or type there.")
    : null;
}

export async function runHeldExtensionOp(
  ctx: BrowserToolCtx,
  op: DaemonOp,
  heldOpId: string,
): Promise<DaemonResult> {
  if (!(await isExtensionBrowserControlEnabled())) {
    await expireHeldOp(ctx.tenant_id, heldOpId).catch(() => undefined);
    return fail(
      "browser_write_extension_disabled",
      "Zavi is not allowed to click or type in this tab right now, so the confirmed step did not run.",
    );
  }
  return runOpImpl(ctx, op, heldOpId);
}

export const extensionBackend: BrowserBackend = {
  runOp(ctx: BrowserToolCtx, op: DaemonOp): Promise<DaemonResult> {
    return runOpImpl(ctx, op);
  },
};

async function runOpImpl(ctx: BrowserToolCtx, op: DaemonOp, heldOpId?: string): Promise<DaemonResult> {
  const halted = runHalted.get(ctx.run_id);
  if (halted) {
    return fail(halted, "This task already stopped because the tab left its starting site.");
  }
  if (!ctx.extension || !ctx.user_id) {
    return fail("no_panel", "This run has no Zavi panel attached to a tab.");
  }
  const navUrl = navTargetUrl(op);
  if (navUrl !== null && !registrableSite(navUrl)) {
    return fail("nav_blocked", "Zavi only opens http and https pages in your tab.");
  }

  const isWrite = classifyBrowserOp(op) === "write";
  if (!runSite.has(ctx.run_id) || isWrite) {
    const stop = await checkWhereTabIs(ctx, op, isWrite);
    if (stop) return stop;
  }

  const pinned = runSite.get(ctx.run_id);
  if (navUrl !== null && pinned && registrableSite(navUrl) !== pinned) {
    return halt(ctx.run_id, pinned, registrableSite(navUrl));
  }
  if (isWrite && !pinned) {
    return fail("site_unknown", "The tab is not on a website, so Zavi will not click or type there.");
  }

  const isHover = op.op === "hover_ref" || op.op === "hover_xy";
  const writeLike = isWrite || isHover || (navUrl !== null && navLooksSideEffecting(navUrl));
  if (writeLike && !(await isExtensionBrowserControlEnabled().catch(() => false))) {
    if (heldOpId) await expireHeldOp(ctx.tenant_id, heldOpId).catch(() => undefined);
    return fail(
      "browser_write_extension_disabled",
      heldOpId
        ? "Zavi is not allowed to click or type in this tab right now, so the confirmed step did not run."
        : "Zavi is not allowed to click or type in this tab right now, so that step did not run.",
    );
  }
  const sent = await sendOp(ctx, op, heldOpId);
  if (sent.top_url) {
    const seen = registrableSite(sent.top_url);
    const pin = runSite.get(ctx.run_id);
    if (!pin && seen) runSite.set(ctx.run_id, seen);
    else if (pin && seen !== pin) return halt(ctx.run_id, pin, seen);
  }
  return sent.outcome;
}
