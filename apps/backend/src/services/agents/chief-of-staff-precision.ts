
import { serviceClient } from "@/services/supabase";

const DISPATCH_SPECIALIST_CLASS = "chief-of-staff.dispatch-specialist";

export const COS_PRECISION_WINDOW_DAYS = 30;
export const COS_MAX_DISPATCHES_SCANNED = 60;
export const COS_MIN_SETTLED_SAMPLE = 3;
export const COS_REJECTED_INTENT_LIMIT = 6;
const COS_INTENT_CAP = 160;

import { decisionVerdict } from "../decisions/status";

export type RejectedIntent = {
  target_agent_slug: string;
  intent: string;
  rejected_at: string;
};

export type CosDispatchPrecision = {
  precision: number | null;
  settled: number;
  accepted: number;
  rejected: number;
  emitted: number;
  pending: number;
  rejected_intents: RejectedIntent[];
};

const NEUTRAL: CosDispatchPrecision = {
  precision: null,
  settled: 0,
  accepted: 0,
  rejected: 0,
  emitted: 0,
  pending: 0,
  rejected_intents: [],
};

function cap(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function computeCosDispatchPrecision(
  tenant_id: string,
): Promise<CosDispatchPrecision> {
  try {
    const sb = serviceClient();
    const since = new Date(
      Date.now() - COS_PRECISION_WINDOW_DAYS * 86400 * 1000,
    ).toISOString();

    const { data, error } = await sb
      .from("decisions")
      .select("body, status, emitted_at, dispatch_error")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", DISPATCH_SPECIALIST_CLASS)
      .gt("emitted_at", since)
      .order("emitted_at", { ascending: false })
      .limit(COS_MAX_DISPATCHES_SCANNED);

    if (error) {
      console.warn(
        `[cos-precision] decisions read failed for ${tenant_id}: ${error.message}`,
      );
      return NEUTRAL;
    }

    const rows = (data ?? []) as Array<{
      body: unknown;
      status: string | null;
      emitted_at: string | null;
    }>;
    if (rows.length === 0) return NEUTRAL;

    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    const rejected_intents: RejectedIntent[] = [];

    for (const r of rows) {
      const status = String(r.status ?? "proposed");
      const verdict = decisionVerdict(
        {
          status,
          dispatch_error: (r as { dispatch_error?: string | null }).dispatch_error ?? null,
          body: (r.body ?? {}) as Record<string, unknown>,
        },
        { approvedCountsAsAccepted: true },
      );
      if (verdict === "accepted") {
        accepted += 1;
      } else if (verdict === "rejected") {
        rejected += 1;
        if (rejected_intents.length < COS_REJECTED_INTENT_LIMIT) {
          const body = (r.body ?? {}) as {
            target_agent_slug?: unknown;
            intent?: unknown;
          };
          rejected_intents.push({
            target_agent_slug:
              typeof body.target_agent_slug === "string"
                ? body.target_agent_slug
                : "(unknown)",
            intent: cap(
              typeof body.intent === "string" ? body.intent : "",
              COS_INTENT_CAP,
            ),
            rejected_at: String(r.emitted_at ?? ""),
          });
        }
      } else if (status === "proposed") {
        pending += 1;
      }
    }

    const settled = accepted + rejected;
    const precision =
      settled >= COS_MIN_SETTLED_SAMPLE ? accepted / settled : null;

    return {
      precision,
      settled,
      accepted,
      rejected,
      emitted: rows.length,
      pending,
      rejected_intents,
    };
  } catch (e) {
    console.warn(
      `[cos-precision] threw for ${tenant_id}: ${(e as Error).message}`,
    );
    return NEUTRAL;
  }
}

export function renderCosPrecisionBlock(p: CosDispatchPrecision): string {
  const hasPrecision =
    p.settled >= COS_MIN_SETTLED_SAMPLE && p.precision !== null;
  const hasRejections = p.rejected_intents.length > 0;
  if (!hasPrecision && !hasRejections) return "";

  const parts: string[] = [
    "### Promotion-gate calibration (how the founder reacts to your dispatches)",
    "This is the founder's ACTUAL accept/reject record on the dispatches YOU proposed over the last 30 days, from the decisions ledger. Use it to calibrate THIS run's Tier-1 promotion gate — it is guidance, not a hard rule.",
  ];

  if (hasPrecision) {
    const pct = Math.round((p.precision as number) * 100);
    const verdict =
      pct < 50
        ? "LOW — the founder is declining most of what you promote. TIGHTEN your Tier-1 gate this run: promote only fires that clearly cross the RaR/legal/fraud/safety threshold, and push borderline items to Tier 3 with `why_below_t1`. Do not cry wolf."
        : pct < 75
          ? "MIXED — the founder accepts some but declines a meaningful share. Be selective: when torn between Tier 1 and Tier 3, choose Tier 3."
          : "HEALTHY — the founder accepts most of your dispatches. Your gate is well-calibrated; keep promoting true fires.";
    parts.push(
      `\n**Dispatch acceptance: ${pct}% (${p.accepted} accepted / ${p.settled} settled${p.pending > 0 ? `; ${p.pending} still pending your founder's click — not counted` : ""}).** ${verdict}`,
    );
  } else if (hasRejections) {
    parts.push(
      `\n_(Too few settled dispatches to compute a stable acceptance rate, but the founder has rejected some — recalibrate against them below.)_`,
    );
  }

  if (hasRejections) {
    const lines = p.rejected_intents
      .map(
        (r) =>
          `- **${r.target_agent_slug}** — "${r.intent}" (rejected ${r.rejected_at})`,
      )
      .join("\n");
    parts.push(
      "\n**The founder REJECTED these dispatches — do NOT re-promote the same shape unless the situation materially escalated:**",
      lines,
      "_A rejection means the founder consciously judged that fire did NOT warrant a Tier-1 keystroke. Treat the pattern as a promotion-gate correction for this tenant — match it before you promote a similar item._",
    );
  }

  return parts.join("\n");
}
