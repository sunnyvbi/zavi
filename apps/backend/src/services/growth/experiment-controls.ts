import { z } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { holdFactor, readPages } from "./test-stops";
import {
  readBusinessPolicy,
  type BusinessPolicy,
} from "./business-control-policy";

export type ControlledObject = {
  platform: "meta" | "google" | "chatgpt";
  account_id: string;
  object_id: string;
  level: "campaign" | "ad_set";
  campaign_id: string | null;
  name: string | null;
  budget_kind: string;
  budget_usd: number | null;
  status: string | null;
  currency: string;
  as_of: string;
};
export type Experiment = {
  id: string;
  decision_id: string | null;
  name: string;
  hypothesis: string;
  platform: ControlledObject["platform"];
  account_id: string;
  object_id: string;
  level: ControlledObject["level"];
  budget_usd: number;
  stop_on_loss: boolean;
  baseline: { date: string; amounts: Record<string, number> };
  started_at: string;
  ends_at: string;
  policy_revision: number;
  spent_usd: number;
  spend_highwater: Record<string, number>;
  exposure_usd: number;
  state:
    | "monitoring"
    | "stopping"
    | "stop_failed"
    | "stopped"
    | "needs_attention";
  reason: string | null;
  stop_requested_at: string | null;
  pause_action_id: string | null;
  checked_at: string | null;
  stopped_at: string | null;
};
export const experimentInputSchema = z
  .object({
    decision_id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(160),
    hypothesis: z.string().trim().min(1).max(500),
    platform: z.enum(["meta", "google", "chatgpt"]),
    account_id: z.string().min(1).max(64),
    object_id: z.string().min(1).max(64),
    budget_usd: z.number().finite().positive().max(1_000_000),
    ends_at: z.string().datetime(),
    stop_on_loss: z.boolean().default(false),
  })
  .strict();
const HOUR = 3_600_000;
export const freshObject = (o: ControlledObject, now: Date) =>
  Number.isFinite(Date.parse(o.as_of)) &&
  now.getTime() - Date.parse(o.as_of) >= 0 &&
  now.getTime() - Date.parse(o.as_of) <= 3 * HOUR;
export const isStopped = (o: ControlledObject) =>
  /^(PAUSED|ARCHIVED|REMOVED|DELETED|ENDED)$/i.test(o.status ?? "");

export async function readControlledObjects(
  tenantId: string,
): Promise<ControlledObject[]> {
  const data = await readPages<Record<string, unknown>>("Campaign inventory", (from, to) =>
    tenantClient(asTenantId(tenantId))
      .from("ad_campaigns")
      .select(
        "platform, account_id, object_id, level, campaign_id, name, budget_kind, budget_usd, status, currency, as_of",
      )
      .in("platform", ["meta", "google", "chatgpt"])
      .eq("source", "api")
      .order("platform")
      .order("account_id")
      .order("object_id")
      .range(from, to),
  );
  return data.map((o) => ({
    ...o,
    budget_usd: o.budget_usd == null ? null : Number(o.budget_usd),
  })) as ControlledObject[];
}
export async function readExperiments(tenantId: string): Promise<Experiment[]> {
  const since = new Date(Date.now() - 35 * 86_400_000).toISOString();
  const data = await readPages<Record<string, unknown>>("Experiment controls", (from, to) =>
    tenantClient(asTenantId(tenantId))
      .from("growth_experiment_controls")
      .select("*")
      .eq("kind", "registered")
      .or(`stopped_at.is.null,started_at.gte.${since}`)
      .order("started_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  return data.map((e) => ({
    ...e,
    budget_usd: Number(e.budget_usd),
    spent_usd: Number(e.spent_usd),
    exposure_usd: Number(e.exposure_usd),
  })) as Experiment[];
}

export function experimentScope(
  target: ControlledObject,
  all: ControlledObject[],
): ControlledObject[] {
  if (
    target.platform === "chatgpt" &&
    target.budget_kind === "lifetime" &&
    target.level === "campaign" &&
    target.budget_usd != null &&
    target.budget_usd > 0 &&
    target.currency === "USD"
  )
    return [target];
  if (
    target.budget_kind !== "daily" ||
    target.budget_usd == null ||
    target.budget_usd <= 0 ||
    target.currency !== "USD"
  ) {
    throw new Error(
      "Use a separate daily USD budget for this experiment. Shared and lifetime budgets cannot be isolated safely.",
    );
  }
  if (target.platform === "meta" && target.level === "campaign") {
    const children = all.filter(
      (o) =>
        o.platform === target.platform &&
        o.account_id === target.account_id &&
        o.campaign_id === target.object_id &&
        o.level === "ad_set",
    );
    if (!children.length)
      throw new Error("The campaign's complete ad-set inventory is required.");
    return children;
  }
  if (target.level !== (target.platform === "meta" ? "ad_set" : "campaign"))
    throw new Error("Unsupported experiment scope.");
  return [target];
}

export type SpendRow = {
  object_id: string;
  spend_date: string;
  amount_usd: number | string;
};
async function readExperimentSpend(
  tenantId: string,
  target: ControlledObject,
  scope: ControlledObject[],
  date: string,
  until?: string,
): Promise<SpendRow[]> {
  return readPages<SpendRow>("Experiment spend", (from, to) => {
    let query = tenantClient(asTenantId(tenantId))
      .from("ad_spend_daily")
      .select("object_id, spend_date, amount_usd")
      .eq("platform", target.platform)
      .eq("account_id", target.account_id)
      .eq("source", "api")
      .in(
        "object_id",
        scope.map((o) => o.object_id),
      )
      .gte("spend_date", date);
    if (until) query = query.lte("spend_date", until);
    return query.order("object_id").order("spend_date").range(from, to);
  });
}
export function experimentSpent(
  e: Pick<Experiment, "baseline" | "spent_usd"> & {
    spend_highwater?: Record<string, number>;
  },
  rows: SpendRow[],
): number {
  return experimentSpendReading(e, rows).spent_usd;
}
export function experimentSpendReading(
  e: Pick<Experiment, "baseline" | "spent_usd"> & {
    spend_highwater?: Record<string, number>;
  },
  rows: SpendRow[],
) {
  const highwater = { ...e.spend_highwater };
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.object_id}:${r.spend_date}`;
    const value = Number(r.amount_usd);
    if (!Number.isFinite(value) || value < 0 || seen.has(key))
      throw new Error("Invalid or duplicated experiment spend.");
    seen.add(key);
    highwater[key] = Math.max(
      highwater[key] ?? 0,
      value - (e.baseline.amounts[key] ?? 0),
    );
  }
  return {
    spent_usd:
      Math.ceil(
        Math.max(
          e.spent_usd,
          Object.values(highwater).reduce((n, v) => n + v, 0),
        ) * 100,
      ) / 100,
    spend_highwater: highwater,
  };
}

export function assessExperiment(
  e: Experiment,
  o: ControlledObject,
  spent: number,
  p: BusinessPolicy,
  now: Date,
) {
  const stale = !freshObject(o, now);
  const paused = !stale && isStopped(o);
  const daily = Number(o.budget_usd);
  const hours =
    p.reporting_delay_hours +
    1 +
    Math.max(0, (now.getTime() - Date.parse(o.as_of)) / HOUR);
  const capped = o.budget_kind === "lifetime" && Number.isFinite(daily) && daily > 0 && daily <= e.budget_usd;
  const exposure = capped
    ? spent
    : Number.isFinite(daily) && daily > 0
      ? spent + (daily * holdFactor(o.platform) * hours) / 24
      : Number.POSITIVE_INFINITY;
  const reason =
    now.getTime() >= Date.parse(e.ends_at)
      ? "Experiment duration ended."
      : spent >= e.budget_usd
        ? "Experiment budget reached."
        : stale
          ? "Spend reporting is stale; stopping protects the experiment budget."
          : exposure >= e.budget_usd
            ? "Remaining budget is needed to cover reporting delay and the next check."
            : null;
  return {
    spent_usd: spent,
    exposure_usd: Number.isFinite(exposure)
      ? Math.ceil(exposure * 100) / 100
      : e.budget_usd,
    stop:
      !!reason ||
      !!e.stop_requested_at ||
      ["stopping", "stop_failed", "stopped"].includes(e.state),
    paused,
    reason: reason ?? e.reason,
  };
}

export async function registerExperiment(
  tenantId: string,
  actor: string | null,
  raw: unknown,
  now = new Date(),
): Promise<string> {
  const input = experimentInputSchema.parse(raw);
  const p = await readBusinessPolicy(tenantId);
  if (!p?.enabled || !p.automatic_stops)
    throw new Error(
      "Save business controls and automatic-stop permission first.",
    );
  const end = Date.parse(input.ends_at);
  if (end <= now.getTime() || end > now.getTime() + 30 * 24 * HOUR)
    throw new Error("Choose a duration between now and 30 days.");
  const all = await readControlledObjects(tenantId);
  const target = all.find(
    (o) =>
      o.platform === input.platform &&
      o.account_id === input.account_id &&
      o.object_id === input.object_id,
  );
  if (!target || !freshObject(target, now))
    throw new Error(
      "A fresh campaign read is required before registering this test.",
    );
  const scope = experimentScope(target, all);
  const lifetime = target.budget_kind === "lifetime";
  if (lifetime && target.budget_usd! > input.budget_usd)
    throw new Error(`The campaign's lifetime total ($${target.budget_usd!.toFixed(2)}) is above the experiment budget. Lower the total or raise the budget.`);
  const minimum = lifetime ? 0 : (target.budget_usd! * 2 * (p.reporting_delay_hours + 1)) / 24;
  if (!lifetime && input.budget_usd <= minimum)
    throw new Error(
      `The experiment budget must exceed $${minimum.toFixed(2)} to cover this daily rate and reporting allowance. Lower the daily rate or increase the total budget.`,
    );
  if (scope.some((o) => !freshObject(o, now)))
    throw new Error("Every child of a campaign budget needs a fresh read.");
  const existing = await readExperiments(tenantId);
  const retry =
    input.decision_id &&
    existing.find(
      (e) =>
        e.decision_id === input.decision_id &&
        e.platform === input.platform &&
        e.account_id === input.account_id &&
        e.object_id === input.object_id,
    );
  if (retry) return retry.id;
  if (input.stop_on_loss && input.platform === "chatgpt")
    throw new Error(
      "ChatGPT experiments support spend and duration stops; purchase evidence is not available.",
    );
  if (
    existing.some(
      (e) =>
        (!e.stopped_at ||
          Date.parse(e.stopped_at) + (p.reporting_delay_hours + 24) * HOUR >
            now.getTime()) &&
        e.platform === target.platform &&
        e.account_id === target.account_id &&
        (e.object_id === target.object_id ||
          e.object_id === target.campaign_id ||
          scope.some((o) => o.object_id === e.object_id)),
    )
  ) {
    throw new Error(
      "This campaign budget belongs to an active experiment or is still settling after its stop.",
    );
  }
  const date = new Date(now.getTime() - 24 * HOUR).toISOString().slice(0, 10);
  const rows = await readExperimentSpend(tenantId, target, scope, date);
  experimentSpent({ baseline: { date, amounts: {} }, spent_usd: 0 }, rows);
  const baseline = {
    date,
    amounts: Object.fromEntries(
      rows.map((r) => [`${r.object_id}:${r.spend_date}`, Number(r.amount_usd)]),
    ),
  };
  const { data, error } = await tenantRpc(
    asTenantId(tenantId),
    "register_growth_experiment",
    {
      p_actor: actor,
      p_experiment: {
        ...input,
        level: target.level,
        baseline,
        policy_revision: p.revision,
      },
    },
  );
  if (error || data?.status !== "created")
    throw new Error(
      error?.message ?? "Controls changed. Reload before starting the test.",
    );
  return data.id as string;
}

export async function experimentReading(
  tenantId: string,
  e: Experiment,
  all: ControlledObject[],
  p: BusinessPolicy,
  now: Date,
) {
  const target = all.find(
    (o) =>
      o.platform === e.platform &&
      o.account_id === e.account_id &&
      o.object_id === e.object_id,
  );
  if (!target)
    throw new Error(
      "Experiment campaign cannot be read; its spend remains reserved.",
    );
  const scope = experimentScope(target, all);
  let rows: SpendRow[];
  try {
    rows = await readExperimentSpend(
      tenantId,
      target,
      scope,
      e.baseline.date,
      e.stopped_at
        ? new Date(Date.parse(e.stopped_at) + 24 * HOUR)
            .toISOString()
            .slice(0, 10)
        : undefined,
    );
  } catch {
    return {
      target,
      assessment: {
        ...assessExperiment(e, target, e.spent_usd, p, now),
        stop: true,
        exposure_usd: Math.max(e.budget_usd, e.exposure_usd),
        reason:
          "Spend cannot be verified; stop to protect the experiment budget.",
        spend_highwater: e.spend_highwater,
      },
    };
  }
  const reading = experimentSpendReading(e, rows);
  const assessment = {
    ...assessExperiment(e, target, reading.spent_usd, p, now),
    spend_highwater: reading.spend_highwater,
  };
  if (!assessment.stop && e.stop_on_loss && e.platform !== "chatgpt") {
    const { readBusinessInventory, businessEvidence } =
      await import("./business-control-runtime");
    const { judgeBusinessResult } = await import("./business-control-policy");
    const inv = await readBusinessInventory(tenantId, now);
    const o = inv.objects.find(
      (o) => o.platform === e.platform && o.id === e.object_id,
    );
    if (
      o &&
      judgeBusinessResult(
        p,
        businessEvidence(
          o,
          inv.tracking[e.platform] === true,
          now,
          true,
          inv.matchesGoal,
        ),
      ).kind === "loser"
    ) {
      assessment.stop = true;
      assessment.reason =
        "The campaign's last seven days miss the saved business-result limit.";
    }
  }
  return { target, assessment };
}
