"use client";

import { useMemo, useState } from "react";
import { Calendar, CircleDollarSign, Gauge, Percent, Receipt, RefreshCw, Target, Wallet } from "lucide-react";
import { startGoogleAdsConnect } from "@/app/connectors/GoogleAdsConnectButton";
import { ActionSection } from "../actions/ActionSection";
import { platformFor } from "../actions/platforms";
import type { PlatformSpec } from "../actions/types";
import { storeUnresolved, useChannelActions } from "../actions/useChannelActions";
import { SummaryRow, type MetricDisplay } from "../metrics/SummaryRow";
import { DashboardShell, EmptyState, Menu, btn, useAgentDashboard } from "./dashboard-ui";
import { AccountStrip, GoogleMark } from "./google-ads/AccountStrip";
import { CampaignTable } from "./google-ads/CampaignTable";
import { MonthlyPlan } from "./google-ads/MonthlyPlan";
import { gadsActionsToViews, gadsKpisToMetrics, legacyApprovalHandlers } from "./legacyChannelActions";
import { DEFAULT_RANGES, periodLabel, type GadsPayload } from "./google-ads/types";

const DISPLAY: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign },
  conversions: { label: "Conversions", icon: Target },
  cpa: { label: "Cost per conversion", icon: Receipt },
  conv_value: { label: "Conversion value", icon: Wallet },
  roas: { label: "ROAS", icon: Percent },
  pacing: { label: "Spend vs plan", icon: Gauge },
};

const SPEND_KEYS = ["spend", "cpa", "pacing"];

export function GoogleAdsPanel() {
  const [rangeId, setRangeId] = useState("30d");
  const days = (DEFAULT_RANGES.find((r) => r.id === rangeId) ?? DEFAULT_RANGES[2]).days;
  const params = useMemo(() => ({ days: String(days) }), [days]);
  const state = useAgentDashboard<GadsPayload>("google_ads", { params });
  const channel = useChannelActions("google_ads");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = () => (state.refreshSilent ?? state.refresh)();

  const legacy = legacyApprovalHandlers({
    setBusy,
    setNotice,
    refetch,
    approvedNote: "Approved. Zavi is making the change in Google Ads now.",
  });

  return (
    <DashboardShell<GadsPayload>
      state={state}
      genericFallback={<EmptyState title="No Google Ads panel yet">Connect Google Ads in Settings and run the channel once.</EmptyState>}
      render={(d) => {
        const switched = channel.store === "channel_actions";
        const storeUnknown = channel.store === "unknown";
        const storeFailed = storeUnresolved(channel);
        const actions = storeUnknown ? [] : switched ? channel.actions : gadsActionsToViews(d.actions);
        const handlers = switched ? channel.handlers : legacy;
        const busyId = switched ? channel.busyId : busy;
        const message = switched ? channel.notice : notice;
        const metrics = channel.metrics.length ? channel.metrics : gadsKpisToMetrics(d);
        const spend = metrics.filter((m) => SPEND_KEYS.includes(m.key));
        const rest = metrics.filter((m) => !SPEND_KEYS.includes(m.key));
        const hasPacing = spend.some((m) => m.key === "pacing");
        const pacing = d.kpis.find((k) => k.key === "pacing")?.pacing ?? null;
        const newIds =
          switched || storeUnknown
            ? undefined
            : new Set(d.actions.filter((a) => a.is_new).map((a) => a.decision_id));
        const platform: PlatformSpec = {
          ...platformFor("google_ads"),
          ...(d.account?.name ? { account: { name: d.account.name, handle: d.account.customer_id } } : {}),
        };

        return (
          <div className="space-y-8">
            <div className="flex flex-wrap items-center gap-3">
              <div className="ml-auto flex items-center gap-2">
                <Menu label={periodLabel(DEFAULT_RANGES.find((r) => r.id === rangeId) ?? DEFAULT_RANGES[2], d.period)} icon={<Calendar className="h-4 w-4 text-inkMuted" aria-hidden />}>
                  {(close) => (
                    <ul>
                      {(d.ranges?.length ? d.ranges : DEFAULT_RANGES).map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={r.id === rangeId}
                            className={`flex w-full px-3 py-2 text-left text-[16px] text-ink hover:bg-creamDeep ${r.id === rangeId ? "bg-bone font-semibold" : ""}`}
                            onClick={() => {
                              setRangeId(r.id);
                              close();
                            }}
                          >
                            {r.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Menu>
                <button type="button" onClick={state.refresh} disabled={state.refreshing} className={btn.secondary}>
                  <RefreshCw className={`h-4 w-4 ${state.refreshing ? "animate-spin" : ""}`} aria-hidden />
                  {state.refreshing ? "Reading…" : "Refresh"}
                </button>
              </div>
            </div>

            {message && <p role="status" className="text-[16px] text-inkMuted">{message}</p>}

            {!d.connected ? (
              <div className="rounded-2xl border border-rule bg-creamDeep p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-rule bg-cream">
                      <GoogleMark />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-ink">Connect Google Ads</p>
                      <p className="text-[16px] text-inkMuted">Zavi reads your campaigns and proposes changes. Nothing changes in your account without your approval.</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => void startGoogleAdsConnect()} className={btn.primary}>
                    Connect
                  </button>
                </div>
              </div>
            ) : (
              <>
                {d.error_code === "google_ads_token_revoked" ? (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3">
                    <p className="text-[16px] text-ink">Google Ads stopped accepting Zavi&apos;s access, so these numbers could not be read. Reconnect to bring them back.</p>
                    <button type="button" onClick={() => void startGoogleAdsConnect()} className={btn.primary}>
                      Reconnect
                    </button>
                  </div>
                ) : d.error_code ? (
                  <p role="status" className="rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[16px] text-ink">
                    Zavi could not read your Google Ads account just now. Try Refresh in a minute.
                  </p>
                ) : null}

                {d.kpis.length > 0 && <AccountStrip d={d} />}

                {metrics.length > 0 && (
                  <section className="space-y-3" aria-label="Headline numbers">
                    {spend.length > 0 && <SummaryRow metrics={spend} variant={hasPacing ? "spend" : "grid"} display={DISPLAY} />}
                    {hasPacing && pacing && <MonthlyPlan p={pacing} onSaved={refetch} />}
                    {rest.length > 0 && <SummaryRow metrics={rest} display={DISPLAY} label="More numbers" />}
                  </section>
                )}

                {d.kpis.length > 0 && <CampaignTable d={d} />}

                <ActionSection
                  actions={actions}
                  completed={!storeUnknown && switched ? channel.completed : undefined}
                  platform={platform}
                  handlers={handlers}
                  busyId={busyId}
                  newIds={newIds}
                  more={storeUnknown ? 0 : switched ? channel.more : (d.actions_more ?? 0)}
                  onShowMore={switched ? channel.showAll : undefined}
                  empty={
                    storeFailed ? (
                      <span>
                        Zavi could not load these actions just now, so none are shown rather than the wrong ones.{" "}
                        <button type="button" onClick={channel.reload} className="font-medium text-ink underline underline-offset-2">
                          Try again
                        </button>
                      </span>
                    ) : storeUnknown ? (
                      <span role="status" aria-busy="true">
                        Reading what is waiting on this channel…
                      </span>
                    ) : (
                      "Nothing waiting right now. When Zavi finds a change worth making in your account, it shows up here with the numbers behind it."
                    )
                  }
                />
              </>
            )}
          </div>
        );
      }}
    />
  );
}
