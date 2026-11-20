
import { CGO_MAX_RAISE_STEP } from "./cgo-spend-authority";
import { tiktokBudgetBody, tiktokStatusBody, TIKTOK_CREATE_LAUNCH_CLASS, TIKTOK_SET_STATUS_CLASS, TIKTOK_UPDATE_BUDGET_CLASS } from "@/services/connectors/tiktok-ads/held-schema";
import { tiktokLaunchBody } from "@/services/connectors/tiktok-ads/launch-schema";
import { founderSetBudgetReason } from "./founder-set-budget";
import { budgetTestReasons } from "./budget-test-shape";
import type { UnattendedAction, UnattendedFacts, UnattendedVerdict } from "./unattended-policy";

type Action = Extract<UnattendedAction, { kind: "ad" }>;

export function tiktokShape(action: Pick<Action, "exec_class" | "payload">):
  | { kind: "budget"; objectId: string; fromUsd: number; toUsd: number; direction: "up" | "down" }
  | { kind: "status"; objectId: string; direction: "up" | "down" }
  | { kind: "create"; direction: "create" }
  | { kind: "never"; why: string } {
  if (action.exec_class === TIKTOK_CREATE_LAUNCH_CLASS) {
    const b = tiktokLaunchBody.safeParse(action.payload);
    if (!b.success) return { kind: "never", why: "body_unreadable" };
    if (b.data.origin !== "specialist") return { kind: "never", why: "founder_staged_change" };
    return { kind: "create", direction: "create" };
  }
  if (action.exec_class === TIKTOK_UPDATE_BUDGET_CLASS) {
    const b = tiktokBudgetBody.safeParse(action.payload);
    if (!b.success) return { kind: "never", why: "body_unreadable" };
    if (b.data.origin !== "specialist") return { kind: "never", why: "founder_staged_change" };
    return { kind: "budget", objectId: b.data.object_id, fromUsd: b.data.expected_current_daily_budget_usd, toUsd: b.data.daily_budget_usd, direction: b.data.daily_budget_usd > b.data.expected_current_daily_budget_usd ? "up" : "down" };
  }
  if (action.exec_class === TIKTOK_SET_STATUS_CLASS) {
    const b = tiktokStatusBody.safeParse(action.payload);
    if (!b.success) return { kind: "never", why: "body_unreadable" };
    if (b.data.origin !== "specialist") return { kind: "never", why: "founder_staged_change" };
    return { kind: "status", objectId: b.data.object_id, direction: b.data.status === "ACTIVE" ? "up" : "down" };
  }
  return { kind: "never", why: "class_not_on_unattended_list" };
}

const NOTE_ONLY_UP: ReadonlySet<string> = new Set(["tracking_unknown", "tracking_broken", "goal_number_untrusted"]);

export function evaluateTiktokAd(action: Action, f: UnattendedFacts): UnattendedVerdict {
  const shape = tiktokShape(action);
  if (shape.kind === "never") return { verdict: "deny", reasons: [shape.why] };
  const ask: string[] = [];
  if (shape.direction === "down") {
    if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
    ask.unshift(shape.kind === "status" ? "pause_needs_founder" : "tracking_unknown");
    return { verdict: "ask_founder", reasons: [...new Set(ask)] };
  }
  if (shape.kind === "create") {
    if (f.refsResolved === false) ask.push("object_unresolved");
    if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
    else if (f.openAdvice !== "clear") ask.push("open_advice_unreadable");
    if (f.goal === null || f.goal === undefined) ask.push("goal_unreadable");
    else if (f.goal.present && f.goal.numberTrusted !== true) ask.push("goal_number_untrusted");
    if (f.channelAutorun === false) ask.push("channel_asks_first");
    else if (f.channelAutorun !== true) ask.push("autorun_unreadable");
    ask.push("tracking_unknown");
    const reasons = [...new Set(ask)];
    const underBudget = f.spendUpUnderBudget === true;
    const held = underBudget ? reasons.filter((r) => !NOTE_ONLY_UP.has(r)) : reasons;
    const notes = underBudget ? reasons.filter((r) => NOTE_ONLY_UP.has(r)) : [];
    return held.length ? { verdict: "ask_founder", reasons: held } : { verdict: "allow", reasons: [], ...(notes.length ? { notes } : {}) };
  }
  if (!f.objects || f.objects.length === 0) ask.push("ad_facts_unreadable");
  else if (f.objects.some((o) => o.spend7dUsd === null || o.conversions7d === null)) ask.push("performance_unreadable");
  if (f.refsResolved === false) ask.push("object_unresolved");
  if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
  else if (f.openAdvice !== "clear") ask.push("open_advice_unreadable");
  if (f.goal === null || f.goal === undefined) ask.push("goal_unreadable");
  else if (f.goal.present && f.goal.numberTrusted !== true) ask.push("goal_number_untrusted");
  if (f.channelAutorun === false) ask.push("channel_asks_first");
  else if (f.channelAutorun !== true) ask.push("autorun_unreadable");
  if (f.trackingOk !== true) ask.push(f.trackingOk === false ? "tracking_broken" : "tracking_unknown");
  if (shape.kind === "status") {
    if (f.pausedByFounder !== false) ask.push(f.pausedByFounder === true ? "founder_paused_it" : "pause_owner_unknown");
  } else {
    const fromCents = Math.round(shape.fromUsd * 100);
    const toCents = Math.round(shape.toUsd * 100);
    if (!(fromCents > 0 && toCents <= fromCents * (1 + CGO_MAX_RAISE_STEP))) ask.push("raise_over_cgo_step");
    if (f.zaviRaisedRecently === true) ask.push("raised_in_last_day");
    else if (f.zaviRaisedRecently !== false) ask.push("raise_history_unknown");
    if (f.founderSetBudget === true) ask.push(founderSetBudgetReason(f.founderSetBudgetEvent, "tiktok"));
    else if (f.founderSetBudget !== false) ask.push("budget_owner_unknown");
    ask.push(...budgetTestReasons(f.budgetTest));
  }
  const reasons = [...new Set(ask)];
  const underBudget = f.spendUpUnderBudget === true;
  const held = underBudget ? reasons.filter((r) => !NOTE_ONLY_UP.has(r)) : reasons;
  const notes = underBudget ? reasons.filter((r) => NOTE_ONLY_UP.has(r)) : [];
  return held.length ? { verdict: "ask_founder", reasons: held } : { verdict: "allow", reasons: [], ...(notes.length ? { notes } : {}) };
}
