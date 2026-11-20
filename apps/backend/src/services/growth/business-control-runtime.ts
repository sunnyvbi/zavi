import {
  readBusinessPolicy,
  judgeBusinessResult,
  type BusinessEvidence,
  type SavedBusinessPolicy,
} from "./business-control-policy";
import {
  readControlledObjects,
  readExperiments,
  experimentReading,
  freshObject,
  isStopped,
  type ControlledObject,
  type Experiment,
} from "./experiment-controls";
import type { AdObject, Inventory } from "./ad-spend-controller";
import type { UnattendedAction, UnattendedFacts } from "./unattended-policy";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export function businessEvidence(
  o: AdObject,
  tracking: boolean,
  now: Date,
  fresh = true,
  matchesGoal = false,
): BusinessEvidence {
  return {
    spend: o.spend7d_usd,
    results: typeof o.purchases7d === "number" ? o.purchases7d : null,
    revenue:
      typeof o.purchase_value7d_usd === "number"
        ? o.purchase_value7d_usd
        : null,
    age_days: o.created_at
      ? (now.getTime() - Date.parse(o.created_at)) / 86_400_000
      : Number.NaN,
    fresh,
    tracking_ok: tracking,
    matches_goal: matchesGoal && o.result_kind === "conversions",
    brand: o.brand === true,
  };
}

export function reachOrClickIds(objects: AdObject[]): Set<string> {
  const ids = new Set<string>();
  for (const o of objects) {
    if (o.platform !== "meta" || o.result_kind !== "clicks") continue;
    ids.add(o.id);
    if (o.campaign_id) ids.add(o.campaign_id);
  }
  return ids;
}

export async function readBusinessInventory(
  tenantId: string,
  now: Date,
): Promise<{
  objects: AdObject[];
  tracking: Record<string, boolean>;
  matchesGoal: boolean;
}> {
  const { readMetaInventory, readGoogleInventory, applyGoalBasis } =
    await import("./ad-spend-controller");
  const { loadTracking } = await import("./unattended-policy");
  const { loadAdGoalMode } = await import("./ad-goal-match");
  const reads = await Promise.allSettled([
    readMetaInventory(tenantId, now),
    readGoogleInventory(tenantId),
    loadTracking(tenantId, "meta"),
    loadTracking(tenantId, "google"),
    loadAdGoalMode(tenantId),
  ]);
  const meta =
    reads[0].status === "fulfilled" ? reads[0].value : { objects: [] };
  const google =
    reads[1].status === "fulfilled"
      ? reads[1].value
      : { objects: [], purchases_unread: true, brand_unread: true };
  const mt = reads[2].status === "fulfilled" ? reads[2].value : { ok: false };
  const gt = reads[3].status === "fulfilled" ? reads[3].value : { ok: false };
  const goal =
    reads[4].status === "fulfilled"
      ? reads[4].value
      : { ok: false as const, error: "unread" };
  const based = goal.ok
    ? applyGoalBasis({ meta, google } as unknown as Inventory, goal.mode)
    : ({ meta, google } as unknown as Inventory);
  const protectedIds = reachOrClickIds(meta.objects as AdObject[]);
  const metaObjects = (based.meta.objects as AdObject[]).map((o) =>
    protectedIds.has(o.id) ? { ...o, result_kind: "clicks" as const } : o,
  );
  return {
    objects: [
      ...metaObjects,
      ...(google.purchases_unread
        ? []
        : google.brand_unread
          ? (based.google.objects as AdObject[]).filter((o) => o.brand !== true)
          : (based.google.objects as AdObject[])),
    ],
    matchesGoal: goal.ok && goal.mode !== "native",
    tracking: { meta: mt.ok === true, google: gt.ok === true },
  };
}

function actionObject(action: Extract<UnattendedAction, { kind: "ad" }>) {
  const b = action.payload as Record<string, unknown>;
  const platform: "meta" | "google" | "chatgpt" = action.exec_class.startsWith(
    "meta_ads.",
  )
    ? "meta"
    : action.exec_class.startsWith("google_ads.")
      ? "google"
      : "chatgpt";
  const id = String(b.object_id ?? b.ad_set_id ?? b.campaign_id ?? "");
  const pause = /\.set_status/.test(action.exec_class) && b.status === "PAUSED";
  const budget = /\.update_(ad_set|campaign)_budget/.test(action.exec_class);
  const from = Number(b.expected_current_daily_budget_usd),
    to = Number(b.daily_budget_usd);
  const up = budget
    ? to > from
    : b.status === "ACTIVE" ||
      b.status === "ENABLED" ||
      /create|duplicate/.test(action.exec_class);
  return { platform, id, pause, budget, from, to, up };
}

async function lossStopEvidenceVerified(
  tenantId: string,
  platform: "meta" | "google",
  facts: UnattendedFacts,
) {
  const { loadGoalMatchContext, withGoalMatch } =
    await import("./ad-goal-match");
  const context = await loadGoalMatchContext(tenantId, platform);
  const objects = facts.objects
    ? withGoalMatch(facts.objects, platform, context)
    : null;
  return (
    facts.openAdvice === "clear" &&
    facts.trackingOk === true &&
    !!objects?.length &&
    objects.every(
      (o) =>
        o.learning !== true &&
        (o.lockDays <= 0 ||
          (o.daysSinceEdit != null && o.daysSinceEdit >= o.lockDays)) &&
        o.conversionEventFiring === true &&
        o.conversionObjective === true &&
        o.resultsMatchGoal === true &&
        o.brand !== true &&
        o.brand !== null,
    )
  );
}

export async function checkBusinessControl(
  tenantId: string,
  action: UnattendedAction,
  facts: UnattendedFacts,
  now: Date,
): Promise<{ hold?: string; delegatedStop?: boolean }> {
  if (action.kind !== "ad") return {};
  if (action.exec_class.startsWith("linkedin_ads.") && action.exec_class !== "linkedin_ads.set_status")
    return (await readBusinessPolicy(tenantId))?.enabled
      ? { hold: "business_controls_no_linkedin" }
      : {};
  if (!/^(meta_ads|google_ads|chatgpt_ads)\./.test(action.exec_class))
    return {};
  const policy = await readBusinessPolicy(tenantId);
  if (!policy?.enabled) return {};
  const childCreate = ["meta_ads.create_ad", "meta_ads.duplicate_ad"].includes(
    action.exec_class,
  );
  if (
    [
      "meta_ads.create_custom_audience",
      "meta_ads.create_creative",
      "meta_ads.upload_asset",
    ].includes(action.exec_class)
  )
    return {};
  if (/\.(create|duplicate)/.test(action.exec_class) && !childCreate) {
    const b = action.payload as Record<string, unknown>;
    const preparesPaused = [
      "meta_ads.create_campaign",
      "meta_ads.create_ad_set",
      "google_ads.create_campaign",
      "google_ads.create_ad_group",
      "google_ads.create_ad",
    ].includes(action.exec_class);
    return preparesPaused && (b.status == null || b.status === "PAUSED")
      ? {}
      : { hold: "business_prepare_paused_experiment" };
  }
  const a = actionObject(action);
  if (!a.up && !a.pause && !a.budget) return {};
  if (a.pause && a.platform !== "chatgpt" && facts.openAdvice !== "clear")
    return { hold: "open_advice_unreadable" };
  const all = await readControlledObjects(tenantId);
  const candidates = all.filter(
    (o) => o.platform === a.platform && o.object_id === a.id,
  );
  if (candidates.length !== 1) return { hold: "business_object_unverified" };
  const target = candidates[0]!;
  if (childCreate && freshObject(target, now) && isStopped(target)) return {};
  const level = (action.payload as Record<string, unknown>).level;
  if (
    a.pause &&
    a.platform === "google" &&
    level != null &&
    level !== "campaign"
  )
    return { hold: "business_object_unverified" };
  if (
    a.budget &&
    (!Number.isFinite(a.from) ||
      !Number.isFinite(a.to) ||
      a.from <= 0 ||
      a.to <= 0)
  )
    return { hold: "business_budget_unverified" };
  if (
    a.budget &&
    Math.abs(a.to - a.from) > (a.from * policy.step_percent) / 100 + 0.001
  )
    return { hold: "business_step_exceeded" };
  const experiments = await readExperiments(tenantId);
  const bound = experiments.filter(
    (e) =>
      settling(e, policy, now) &&
      e.platform === a.platform &&
      e.account_id === target.account_id &&
      (e.object_id === a.id || e.object_id === target.campaign_id),
  );
  const experiment = bound.find((e) => !e.stopped_at) ?? bound[0];
  if (experiment) {
    const { assessment } = await experimentReading(
      tenantId,
      experiment,
      all,
      policy,
      now,
    );
    if (a.up && assessment.stop) return { hold: "experiment_stop_required" };
    if (
      a.pause &&
      assessment.stop &&
      policy.automatic_stops &&
      experiment.object_id === a.id
    ) {
      if (
        assessment.reason?.startsWith("The campaign's last seven days") &&
        a.platform !== "chatgpt" &&
        !(await lossStopEvidenceVerified(tenantId, a.platform, facts))
      )
        return { hold: "business_stop_evidence_unverified" };
      return { delegatedStop: true };
    }
    if (a.up) {
      if (!freshObject(target, now))
        return { hold: "experiment_reporting_stale" };
      if (a.budget && a.to > a.from * (1 + policy.step_percent / 100))
        return { hold: "business_step_exceeded" };
      const rate = a.budget
        ? a.to
        : all.find(
            (o) =>
              o.platform === experiment.platform &&
              o.account_id === experiment.account_id &&
              o.object_id === experiment.object_id,
          )?.budget_usd;
      if (
        rate == null ||
        assessment.spent_usd +
          (rate * 2 * (policy.reporting_delay_hours + 1)) / 24 >=
          experiment.budget_usd
      ) {
        return { hold: "experiment_exposure_exceeded" };
      }
      return {};
    }
    return { hold: "experiment_rule_not_reached" };
  }
  if (a.platform === "chatgpt") return { hold: "business_results_unavailable" };
  const inv = await readBusinessInventory(tenantId, now);
  const object = inv.objects.find(
    (o) => o.platform === a.platform && o.id === a.id,
  );
  if (!object) return { hold: "business_results_unavailable" };
  const evidence = businessEvidence(
    object,
    inv.tracking[a.platform] === true,
    now,
    true,
    inv.matchesGoal,
  );
  const verdict = judgeBusinessResult(policy, evidence);
  if (a.pause) {
    if (!(await lossStopEvidenceVerified(tenantId, a.platform, facts)))
      return { hold: "business_stop_evidence_unverified" };
    return verdict.kind === "loser" && policy.automatic_stops
      ? { delegatedStop: true }
      : { hold: "business_stop_not_authorized" };
  }
  if (a.up) {
    if (facts.goal?.present && facts.goal.numberTrusted !== true)
      return { hold: "goal_number_untrusted" };
    if (verdict.kind !== "winner")
      return { hold: "business_evidence_or_experiment_required" };
    if (a.budget && a.to > a.from * (1 + policy.step_percent / 100))
      return { hold: "business_step_exceeded" };
  } else if (a.budget && verdict.kind !== "loser")
    return { hold: "business_loss_not_proven" };
  return {};
}

export function settling(
  e: Experiment,
  p: { reporting_delay_hours: number },
  now: Date,
) {
  return (
    !e.stopped_at ||
    Date.parse(e.stopped_at) + (p.reporting_delay_hours + 24) * 3_600_000 >
      now.getTime()
  );
}

async function stopOrder(
  tenantId: string,
  e: Experiment,
  target: ControlledObject,
  now: Date,
) {
  const reason = `Stop ${e.name}: its saved experiment limit requires a stop.`;
  const base = {
    tenant_id: tenantId,
    reason,
    idempotency_key: `experiment:${e.id}:stop:${e.pause_action_id ?? "initial"}:${now.toISOString().slice(0, 13)}`,
    now,
    dwell_key: `obj:${e.platform}:${e.object_id}`,
  };
  const { submitCgoAdAction } = await import("./cgo-ad-orders");
  if (e.platform === "chatgpt") {
    const { readCampaignTree } =
      await import("@/services/connectors/chatgpt-ads/workspace");
    const { launchSnapshot } =
      await import("@/services/connectors/chatgpt-ads/launch");
    const { withChatgptBudgetCampaign } =
      await import("@/services/ads-wallet/chatgpt-budget-identity");
    const tree = await withChatgptBudgetCampaign(tenantId, e.object_id, (id) =>
      readCampaignTree(tenantId, id),
    );
    return submitCgoAdAction({
      ...base,
      channel_slug: "chatgpt_ads",
      exec_class: "chatgpt_ads.set_status",
      body: {
        campaign_id: e.object_id,
        status: "PAUSED",
        rationale: reason,
        summary: reason,
        name: tree.campaign.name ?? e.name,
        origin: "agent",
        expected_updated_at: tree.campaign.updated_at,
        snapshot: launchSnapshot(tree),
      },
    });
  }
  return submitCgoAdAction({
    ...base,
    channel_slug: e.platform === "meta" ? "meta_ads" : "google_ads",
    exec_class: `${e.platform === "meta" ? "meta_ads" : "google_ads"}.set_status`,
    body: {
      ...(e.platform === "meta"
        ? {
            object_id: e.object_id,
            level: e.level === "ad_set" ? "adset" : "campaign",
          }
        : { campaign_id: e.object_id, level: "campaign" }),
      status: "PAUSED",
      rationale: reason,
      over_cap: false,
      name: target.name ?? e.name,
    },
  });
}

type PendingAction = {
  id: string;
  exec_status: string | null;
  executed_at: string | null;
  exec_claimed_at: string | null;
  exec_payload: Record<string, unknown>;
};
export function experimentStopState(
  e: Experiment,
  target: ControlledObject,
  assessment: { paused: boolean },
  actions: PendingAction[],
) {
  const relevant = actions.filter(
    (a) =>
      String(
        a.exec_payload.object_id ??
          a.exec_payload.ad_set_id ??
          a.exec_payload.campaign_id ??
          "",
      ) === e.object_id,
  );
  const inflight = relevant.some(
    (a) => a.exec_status === "queued" || a.exec_status === "dispatching",
  );
  const previous = actions.find((a) => a.id === e.pause_action_id);
  const latest = relevant.reduce(
    (n, a) =>
      Math.max(n, Date.parse(a.executed_at ?? a.exec_claimed_at ?? "") || 0),
    0,
  );
  const confirmed =
    assessment.paused && !inflight && Date.parse(target.as_of) > latest;
  const wait =
    inflight ||
    (!!e.pause_action_id &&
      (!previous ||
        (previous.exec_status !== "failed" &&
          previous.exec_status !== "executed") ||
        Date.parse(target.as_of) <=
          Date.parse(previous.executed_at ?? previous.exec_claimed_at ?? "")));
  return { confirmed, wait };
}
async function experimentActions(
  tenantId: string,
  e: Experiment,
): Promise<PendingAction[]> {
  const { readPages } = await import("./test-stops");
  return readPages<PendingAction>("Action status", (from, to) =>
    tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("id,exec_status,executed_at,exec_claimed_at,exec_payload")
      .eq(
        "channel_slug",
        e.platform === "meta"
          ? "meta_ads"
          : e.platform === "google"
            ? "google_ads"
            : "chatgpt_ads",
      )
      .gte("proposed_at", e.started_at)
      .order("proposed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
}

export async function monitorExperiments(
  tenantId: string,
  now = new Date(),
): Promise<void> {
  const p = await readBusinessPolicy(tenantId);
  if (!p) return;
  const watched = (await readExperiments(tenantId)).filter(
    (e) =>
      !e.stopped_at ||
      Date.parse(e.stopped_at) > now.getTime() - 7 * 86_400_000,
  );
  if (!watched.length) return;
  const all = await readControlledObjects(tenantId);
  for (const e of watched) {
    let check: Record<string, unknown> = {
      expected_checked_at: e.checked_at,
      spent_usd: e.spent_usd,
      exposure_usd: e.exposure_usd,
    };
    try {
      const { target, assessment: a } = await experimentReading(
        tenantId,
        e,
        all,
        p,
        now,
      );
      check = { ...check, ...a, state: "monitoring" };
      if (e.stopped_at) {
        const saved = await tenantRpc(
          asTenantId(tenantId),
          "record_growth_experiment_check",
          { p_id: e.id, p_check: { ...check, state: "stopped" } },
        );
        if (saved.error) throw new Error(saved.error.message);
        continue;
      }
      const stopState = experimentStopState(
        e,
        target,
        a,
        await experimentActions(tenantId, e),
      );
      if (stopState.confirmed && a.stop) check.state = "stopped";
      else if (a.stop) {
        if (!p.enabled || !p.automatic_stops)
          check = {
            ...check,
            state: "needs_attention",
            reason:
              "Automatic stops are disabled. Pause this experiment in the ad platform.",
          };
        else if (stopState.wait)
          check = {
            ...check,
            state: "stopping",
            reason:
              "Waiting for the pending action and a newer platform read; allocation remains reserved.",
          };
        else {
          const result = await stopOrder(tenantId, e, target, now);
          check = {
            ...check,
            state: result.ok ? "stopping" : "stop_failed",
            reason: result.ok ? a.reason : result.why,
            ...(result.ok ? { pause_action_id: result.action_id } : {}),
          };
        }
      }
    } catch (error) {
      check = {
        ...check,
        state: "needs_attention",
        reason: (error as Error).message,
      };
    }
    const r = await tenantRpc(
      asTenantId(tenantId),
      "record_growth_experiment_check",
      { p_id: e.id, p_check: check },
    );
    if (r.error)
      throw new Error(
        `Experiment monitor could not save its result: ${r.error.message}`,
      );
  }
}
