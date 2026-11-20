
import { createHash } from "node:crypto";
import type { BrowserToolCtx, DaemonOp, DaemonResult, ExtensionNodeRef } from "./types";
import { navTargetUrl } from "./browser-action-gate";
import {
  BUDGET_WORDS_RE,
  billingLooking,
  evidenceFromResolve,
  identityDiff,
  isAdHost,
  isMoneyStep,
  moneyStepIdentity,
  targetFromResolve,
  canonicalOpArgs,
  sameMoneyValue,
  type MoneyEvidence,
  type MoneyVerdict,
} from "./money-step";
import { moneyCardFingerprint } from "@/services/approvals/money-card";

export const MONEY_STEP_DECISION_CLASS = "extension.money_step";
export const MONEY_CONFIRM_WAIT_MS = 10 * 60_000;
const POLL_MS = 1_000;
const SESSION_CHECK_MS = 5_000;

export const NOT_CONFIRMED_COPY = "I didn't get a confirm, so I skipped that step.";

export type DecisionState = {
  status: string;
  approved_by: string | null;
  body: Record<string, unknown> | null;
};

export type MoneyGateDeps = {
  read: (ctx: BrowserToolCtx, op: DaemonOp) => Promise<DaemonResult>;
  run: (ctx: BrowserToolCtx, op: DaemonOp) => Promise<DaemonResult>;
  hold: (ctx: BrowserToolCtx, op: DaemonOp) => Promise<{ ok: true; op_id: string } | { ok: false; outcome: DaemonResult }>;
  runHeld: (ctx: BrowserToolCtx, op: DaemonOp, op_id: string) => Promise<DaemonResult>;
  dropHeld: (tenant_id: string, op_id: string) => Promise<void>;
  heldStatus: (tenant_id: string, op_id: string) => Promise<string | null>;
  emit: (a: { tenant_id: string; agent_run_id: string; decision_class: string; body: Record<string, unknown> }) => Promise<string>;
  readDecision: (tenant_id: string, decision_id: string) => Promise<DecisionState | null>;
  expireDecision: (tenant_id: string, decision_id: string) => Promise<void>;
  sessionLive: (ctx: BrowserToolCtx) => Promise<boolean>;
  logUnsure: (ctx: BrowserToolCtx, op: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function fail(error_code: string, error_message: string): DaemonResult {
  return { ok: false, error_code, error_message };
}

const NOT_CONFIRMED = (): DaemonResult => fail("money_step_not_confirmed", NOT_CONFIRMED_COPY);

export const MOVE_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function moneyCheckApplies(op: DaemonOp): boolean {
  return (
    op.op === "click_ref" ||
    op.op === "type_ref" ||
    op.op === "select_option" ||
    op.op === "set_checked" ||
    op.op === "nav" ||
    (op.op === "key" && (op.key === "Enter" || op.key === "Space" || MOVE_KEYS.has(op.key))) ||
    op.op === "click_xy" ||
    op.op === "drag_ref" ||
    op.op === "drag_xy" ||
    op.op === "choose" ||
    op.op === "reload" ||
    op.op === "history_go" ||
    (op.op === "key_chord" && (op.key === "Enter" || EDITING_CHORD_KEYS.has(op.key)))
  );
}

export const EDITING_CHORD_KEYS: ReadonlySet<string> = new Set(["v", "x", "z", "y", "Delete", "Backspace"]);

const POINT_OPS: ReadonlySet<string> = new Set(["click_xy", "drag_xy"]);

const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

function withFocusPin(op: DaemonOp, l: { identity: Record<string, unknown> }): DaemonOp {
  if (op.op === "key" || op.op === "key_chord") {
    const id = l.identity.backend_node_id;
    const fs = l.identity.frame_session;
    return {
      ...op,
      focus_ref: Number.isInteger(id) ? { frame_session: typeof fs === "string" ? fs : null, backend_node_id: id as number } : null,
    };
  }
  const pin = (id: unknown) => (Number.isInteger(id) ? { frame_session: null, backend_node_id: id as number } : null);
  if (op.op === "click_xy") return { ...op, hit_ref: pin(l.identity.hit_backend_node_id) };
  if (op.op === "drag_xy") return { ...op, hit_ref: pin(l.identity.hit_backend_node_id), to_hit_ref: pin(l.identity.to_hit_backend_node_id) };
  return op;
}

function chosenOption(op: DaemonOp): string | undefined {
  if (op.op === "select_option") return op.label ?? op.value;
  if (op.op === "choose") return op.option;
  return undefined;
}

function refOf(op: DaemonOp): ExtensionNodeRef | null {
  switch (op.op) {
    case "click_ref":
    case "type_ref":
    case "select_option":
    case "set_checked":
    case "drag_ref":
    case "choose":
      return op.ref;
    default:
      return null;
  }
}

function moneyOpOf(op: DaemonOp): "click_ref" | "type_ref" | "select_option" | "set_checked" | "key" {
  if (op.op === "type_ref" || op.op === "select_option" || op.op === "set_checked" || op.op === "key") return op.op;
  if (op.op === "choose") return "select_option";
  if (op.op === "key_chord") return "key";
  return "click_ref";
}

function moneyContext(e: MoneyEvidence): boolean {
  return (
    isAdHost(e.top_url) ||
    isAdHost(e.frame_url) ||
    billingLooking(e.top_url) ||
    billingLooking(e.frame_url) ||
    e.page_has_payment_frame ||
    e.form_has_card_field
  );
}

type Look = {
  evidence: MoneyEvidence;
  verdict: MoneyVerdict;
  identity: Record<string, unknown>;
  dest?: MoneyEvidence;
};

const PASS_THROUGH = new Set(["off_site", "no_panel", "site_unknown", "tab_mismatch", "no_node"]);

async function look(
  ctx: BrowserToolCtx,
  op: DaemonOp,
  deps: MoneyGateDeps,
): Promise<Look | { failed: DaemonResult } | null> {
  const opRec = op as unknown as Record<string, unknown>;
  const navUrl = navTargetUrl(op) ?? (op.op === "reload" ? op.expect_url : null);
  if (navUrl !== null) {
    const evidence: MoneyEvidence = {
      op: "nav",
      top_url: null,
      frame_url: null,
      role: "",
      name: "",
      hints: "",
      is_submit: false,
      form_has_card_field: false,
      budget_fields: [],
      page_has_payment_frame: false,
      nav_url: navUrl,
    };
    const verdict = isMoneyStep(evidence);
    return {
      evidence,
      verdict,
      identity: moneyStepIdentity(opRec, evidence, verdict, { frame_session: null, backend_node_id: null }),
    };
  }
  const ref = refOf(op);
  const at = op.op === "click_xy" || op.op === "drag_xy" ? { x: op.x, y: op.y, shot_w: op.shot_w, shot_h: op.shot_h } : null;
  const res = await deps.read(ctx, at ? { op: "resolve", ref: null, at } : { op: "resolve", ref });
  if (!res.ok) return PASS_THROUGH.has(res.error_code) ? { failed: res } : null;
  const moneyOp = moneyOpOf(op);
  const evidence = evidenceFromResolve(
    { op: moneyOp, text: op.op === "type_ref" ? op.text : chosenOption(op) },
    res.result,
  );
  if (op.op === "key" && op.key === "Space" && TEXT_ENTRY_ROLES.has(evidence.role.toLowerCase())) evidence.is_submit = false;
  const target = targetFromResolve(res.result);
  if (ref && (target.backend_node_id !== ref.backend_node_id || target.frame_session !== ref.frame_session)) {
    return null;
  }
  let verdict = isMoneyStep(evidence);
  const identity: Record<string, unknown> = moneyStepIdentity(opRec, evidence, verdict, target);
  const hitOf = (result: unknown) => {
    const r = (result ?? {}) as { hit_ref?: { backend_node_id?: unknown } | null; hit_kind?: unknown };
    return {
      id: Number.isInteger(r.hit_ref?.backend_node_id) ? (r.hit_ref?.backend_node_id as number) : null,
      kind: typeof r.hit_kind === "string" ? r.hit_kind : "none",
    };
  };
  if (at) {
    const h = hitOf(res.result);
    identity.hit_backend_node_id = h.id;
    identity.hit_kind = h.kind;
  }
  if (op.op !== "drag_ref" && op.op !== "drag_xy") return { evidence, verdict, identity };

  const toAt = op.op === "drag_xy" ? { x: op.to_x, y: op.to_y, shot_w: op.shot_w, shot_h: op.shot_h } : null;
  const dres = await deps.read(
    ctx,
    op.op === "drag_xy"
      ? { op: "resolve", ref: null, at: { x: op.to_x, y: op.to_y, shot_w: op.shot_w, shot_h: op.shot_h } }
      : { op: "resolve", ref: op.to_ref },
  );
  if (!dres.ok) return PASS_THROUGH.has(dres.error_code) ? { failed: dres } : null;
  const dest = evidenceFromResolve({ op: "click_ref" }, dres.result);
  const dt = targetFromResolve(dres.result);
  if (op.op === "drag_ref" && (dt.backend_node_id !== op.to_ref.backend_node_id || dt.frame_session !== op.to_ref.frame_session)) {
    return null;
  }
  const dv = isMoneyStep(dest);
  for (const [k, v] of Object.entries(moneyStepIdentity(opRec, dest, dv, dt))) identity[`to_${k}`] = v;
  if (toAt) {
    const h = hitOf(dres.result);
    identity.to_hit_backend_node_id = h.id;
    identity.to_hit_kind = h.kind;
  }
  if (dv.money || (!verdict.money && dv.unsure)) verdict = dv;
  return { evidence, verdict, identity, dest };
}

async function screenshotId(ctx: BrowserToolCtx, deps: MoneyGateDeps): Promise<string | null> {
  const shot = await deps.read(ctx, { op: "screenshot" });
  const img = shot.ok ? (shot.result as { image_base64?: unknown } | null)?.image_base64 : null;
  if (typeof img !== "string" || img.length === 0) return null;
  return `sha256:${createHash("sha256").update(img).digest("hex").slice(0, 32)}`;
}

export function moneyCardSummary(
  op: string,
  host: string,
  label: string,
  value: string | null,
  valueLine: string | null,
): string {
  if (op === "nav" || op === "history_go" || op === "reload") return `On ${host} I'm about to open the checkout page.`;
  if (op === "type_ref" || op === "select_option" || op === "choose") return `On ${host} I'm about to change "${label}" to ${value ?? ""}.`;
  return `On ${host} I'm about to click "${label}".${valueLine ? ` ${valueLine}` : ""}`;
}

export function moneyValueLine(op: DaemonOp, v: MoneyVerdict): string | null {
  if (!v.value || ["type_ref", "select_option", "choose", "nav", "history_go", "reload"].includes(op.op)) return null;
  return v.value;
}

function redactDialogText(op: DaemonOp): Record<string, unknown> {
  const o = op as unknown as Record<string, unknown>;
  return typeof o.dialog_text === "string" ? { ...o, dialog_text: "[redacted]" } : o;
}

export function buildMoneyStepBody(args: {
  op: DaemonOp;
  look: Look;
  screenshot_id: string;
  run_owner_user_id: string;
  held_op_id: string;
}): Record<string, unknown> {
  const { op, look: l } = args;
  const idn = l.identity;
  const valueLine = moneyValueLine(op, l.verdict);
  const body: Record<string, unknown> = {
    host: l.verdict.host,
    label: l.verdict.label,
    op: op.op,
    op_args: canonicalOpArgs(redactDialogText(op)),
    value: l.verdict.value ?? null,
    value_line: valueLine,
    frame_url: urlWithoutQuery(idn.frame_url),
    frame_session: idn.frame_session ?? null,
    backend_node_id: idn.backend_node_id ?? null,
    screenshot_id: args.screenshot_id,
    run_owner_user_id: args.run_owner_user_id,
    held_op_id: args.held_op_id,
    reason: l.verdict.reason,
    summary: moneyCardSummary(op.op, l.verdict.host, l.verdict.label, l.verdict.value ?? null, valueLine),
  };
  const fingerprint = moneyCardFingerprint(MONEY_STEP_DECISION_CLASS, body);
  return { ...body, fingerprint };
}

const APPROVED = new Set(["approved", "dispatching", "acted"]);

type ConfirmedChange = {
  host: string;
  frame_session: string | null;
  scope_id: number;
  field: string;
  value: string;
};
const confirmedChange = new Map<string, ConfirmedChange>();

export function clearMoneyGateRunState(run_id: string): void {
  confirmedChange.delete(run_id);
}
export function _resetMoneyGateState(): void {
  confirmedChange.clear();
}

function urlWithoutQuery(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return null;
  }
}

const CARRY_REASONS = new Set(["ad_budget_save", "money_label_in_context"]);

function carriesConfirmedChange(c: ConfirmedChange, l: Look): boolean {
  const e = l.evidence;
  if (l.dest) return false;
  if (e.op !== "click_ref" && e.op !== "key") return false;
  if (!CARRY_REASONS.has(l.verdict.reason)) return false;
  if (l.verdict.host !== c.host) return false;
  if ((l.identity.frame_session ?? null) !== c.frame_session) return false;
  if (e.scope_id !== c.scope_id) return false;
  if (e.budget_truncated) return false;
  const matches = e.budget_fields.filter((f) => f.label === c.field);
  if (matches.length !== 1) return false;
  return sameMoneyValue(matches[0].value, c.value);
}

export async function runWithMoneyGate(
  ctx: BrowserToolCtx,
  op: DaemonOp,
  deps: MoneyGateDeps,
): Promise<DaemonResult> {
  if (!moneyCheckApplies(op)) return deps.run(ctx, op);
  if (!ctx.user_id) return fail("no_panel", "This run has no Zavi panel attached to a tab.");

  const first = await look(ctx, op, deps);
  if (first && "failed" in first) return first.failed;
  if (!first) {
    return fail("money_check_failed", "Zavi could not check this step before running it, so it did not run. Take a fresh snapshot and try again.");
  }
  const exec = withFocusPin(op, first);
  const e0 = first.evidence;
  const onAdBudget = (isAdHost(e0.top_url) || isAdHost(e0.frame_url)) && BUDGET_WORDS_RE.test(`${e0.name} ${e0.hints}`);
  const valueChangingKey =
    (op.op === "key" && MOVE_KEYS.has(op.key)) || (op.op === "key_chord" && EDITING_CHORD_KEYS.has(op.key));
  if (valueChangingKey) {
    if (onAdBudget) {
      return fail(
        "key_on_money_field",
        "Arrow keys, paste, cut, undo and delete are not used on a budget or bid field. Type the amount, or choose it with select, so Zavi can confirm it with you.",
      );
    }
    return deps.run(ctx, exec);
  }
  const d0 = first.dest;
  const destOnAdBudget = !!d0 && (isAdHost(d0.top_url) || isAdHost(d0.frame_url)) && BUDGET_WORDS_RE.test(`${d0.name} ${d0.hints}`);
  if ((op.op === "drag_ref" || op.op === "drag_xy") && (onAdBudget || destOnAdBudget)) {
    return fail(
      "drag_on_money_field",
      "Zavi does not drag a budget or bid control. Type the amount, or choose it with select, so Zavi can confirm it with you.",
    );
  }
  const opaquePoint =
    first.identity.hit_kind !== "element" || (op.op === "drag_xy" && first.identity.to_hit_kind !== "element");
  if (POINT_OPS.has(op.op) && opaquePoint && (moneyContext(e0) || (d0 !== undefined && moneyContext(d0)))) {
    return fail(
      "coordinate_on_money_page",
      "Zavi cannot tell what is at that point on a page that can spend money, so it did not click there. Use a numbered element instead.",
    );
  }
  if (!first.verdict.money) {
    if (first.verdict.unsure) await deps.logUnsure(ctx, op.op).catch(() => undefined);
    return deps.run(ctx, exec);
  }

  const carried = confirmedChange.get(ctx.run_id);
  confirmedChange.delete(ctx.run_id);
  if (carried && carriesConfirmedChange(carried, first)) return deps.run(ctx, exec);

  const shot = await screenshotId(ctx, deps);
  if (!shot) return fail("money_check_failed", "Zavi could not capture the tab before a step that spends money, so it did not run.");

  const held = await deps.hold(ctx, exec);
  if (!held.ok) return held.outcome;
  const op_id = held.op_id;
  const drop = () => deps.dropHeld(ctx.tenant_id, op_id).catch(() => undefined);

  const body = buildMoneyStepBody({ op, look: first, screenshot_id: shot, run_owner_user_id: ctx.user_id, held_op_id: op_id });
  let decision_id: string;
  try {
    decision_id = await deps.emit({
      tenant_id: ctx.tenant_id,
      agent_run_id: ctx.run_id,
      decision_class: MONEY_STEP_DECISION_CLASS,
      body,
    });
  } catch {
    await drop();
    return fail("money_confirm_unavailable", "Zavi could not ask you to confirm this step, so it did not run.");
  }

  const own = await deps.readDecision(ctx.tenant_id, decision_id).catch(() => null);
  if (!own || own.body?.held_op_id !== op_id || own.body?.fingerprint !== body.fingerprint) {
    await drop();
    return fail("money_confirm_unavailable", "Zavi could not ask you to confirm this step, so it did not run.");
  }

  const waitStarted = deps.now();
  try {
    return await waitAndRun(ctx, op, deps, { first, own, op_id, decision_id, drop, waitStarted });
  } finally {
    ctx.on_confirm_wait?.(Math.max(0, deps.now() - waitStarted));
  }
}

async function waitAndRun(
  ctx: BrowserToolCtx,
  op: DaemonOp,
  deps: MoneyGateDeps,
  w: {
    first: Look;
    own: DecisionState;
    op_id: string;
    decision_id: string;
    drop: () => Promise<void>;
    waitStarted: number;
  },
): Promise<DaemonResult> {
  const { first, op_id, decision_id, drop } = w;
  const deadline = w.waitStarted + MONEY_CONFIRM_WAIT_MS;
  let lastSessionCheck = w.waitStarted;
  let state: DecisionState | null = w.own;
  for (;;) {
    if (state && state.status !== "proposed") break;
    if (deps.now() >= deadline) {
      await deps.expireDecision(ctx.tenant_id, decision_id).catch(() => undefined);
      state = await deps.readDecision(ctx.tenant_id, decision_id).catch(() => null);
      break;
    }
    const heldNow = await deps.heldStatus(ctx.tenant_id, op_id).catch(() => null);
    if (heldNow !== "awaiting_confirm") {
      await deps.expireDecision(ctx.tenant_id, decision_id).catch(() => undefined);
      return fail("extension_op_expired", "The task was stopped while waiting for your confirm. The step did not run.");
    }
    if (deps.now() - lastSessionCheck >= SESSION_CHECK_MS) {
      lastSessionCheck = deps.now();
      if (!(await deps.sessionLive(ctx).catch(() => false))) {
        await deps.expireDecision(ctx.tenant_id, decision_id).catch(() => undefined);
        await drop();
        return fail("no_panel", "The Zavi panel was closed while waiting for your confirm. The step did not run.");
      }
    }
    await deps.sleep(POLL_MS);
    state = await deps.readDecision(ctx.tenant_id, decision_id).catch(() => null);
  }

  if (!state || !APPROVED.has(state.status)) {
    await drop();
    return NOT_CONFIRMED();
  }
  if (state.approved_by !== ctx.user_id || state.body?.run_owner_user_id !== ctx.user_id) {
    await drop();
    return fail("money_confirm_refused", "Only the person running this task can confirm it. The step did not run.");
  }

  const againRaw = await look(ctx, op, deps);
  if (againRaw && "failed" in againRaw) {
    await drop();
    return againRaw.failed;
  }
  const again = againRaw;
  const shotAgain = again ? await screenshotId(ctx, deps) : null;
  if (!again || !shotAgain || !again.verdict.money || identityDiff(first.identity, again.identity).length > 0) {
    await drop();
    return fail("stale", "The page changed after you confirmed, so Zavi did not run that step. Nothing was clicked.");
  }
  const done = await deps.runHeld(ctx, withFocusPin(op, again), op_id);
  const e = again.evidence;
  if (
    done.ok &&
    (op.op === "type_ref" || op.op === "select_option" || op.op === "choose") &&
    again.verdict.reason === "ad_budget_field" &&
    typeof e.scope_id === "number"
  ) {
    const r = done.result as { value?: unknown; chosen?: unknown } | undefined;
    const shown = r?.value ?? r?.chosen;
    confirmedChange.set(ctx.run_id, {
      host: again.verdict.host,
      frame_session: (again.identity.frame_session as string | null) ?? null,
      scope_id: e.scope_id,
      field: again.verdict.label,
      value: op.op === "type_ref" ? op.text : typeof shown === "string" ? shown : (chosenOption(op) ?? ""),
    });
  }
  return done;
}

let depsOverride: Partial<MoneyGateDeps> | null = null;
export function _setMoneyGateDeps(d: Partial<MoneyGateDeps> | null): void {
  depsOverride = d;
}

export async function moneyGateDeps(): Promise<MoneyGateDeps> {
  const [ext, ops, anchor, tc, log] = await Promise.all([
    import("./extension-backend"),
    import("@/services/extension/browser-ops"),
    import("./anchor-backend"),
    import("@/services/tenant-client"),
    import("@/services/logging/logEvent"),
  ]);
  const decisions = (tenant_id: string) => tc.tenantClient(tc.asTenantId(tenant_id)).from("decisions");
  const defaults: MoneyGateDeps = {
    read: (ctx, op) => ext.extensionBackend.runOp(ctx, op),
    run: (ctx, op) => ext.extensionBackend.runOp(ctx, op),
    hold: (ctx, op) => ext.holdExtensionOp(ctx, op),
    runHeld: (ctx, op, id) => ext.runHeldExtensionOp(ctx, op, id),
    dropHeld: (tenant_id, id) => ops.expireHeldOp(tenant_id, id),
    heldStatus: (tenant_id, id) => ops.readOpStatus(tenant_id, id),
    emit: (a) => anchor.getBrowserActionEmitter().emit(a),
    readDecision: async (tenant_id, id) => {
      const { data, error } = await decisions(tenant_id)
        .select("status, approved_by, body")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DecisionState | null) ?? null;
    },
    expireDecision: async (tenant_id, id) => {
      const { error } = await decisions(tenant_id)
        .update({ status: "expired" })
        .eq("id", id)
        .eq("status", "proposed");
      if (error) throw new Error(error.message);
    },
    sessionLive: (ctx) =>
      ctx.extension && ctx.user_id
        ? ops.isSessionLive(ctx.extension.panel_session_id, ctx.tenant_id, ctx.user_id)
        : Promise.resolve(false),
    logUnsure: (ctx, opName) =>
      log.logEvent({
        level: "info",
        source: "extension.money_unsure",
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        meta: { tool_name: opName, code: "money_unsure" },
      }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return depsOverride ? { ...defaults, ...depsOverride } : defaults;
}
