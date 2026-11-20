"use client";

import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  AttentionList,
  EmptyState,
  num,
  ago,
  type AttentionItem,
} from "./dashboard-ui";

type ChannelRow = {
  channel_id: string;
  name: string;
  message_count: number;
  distinct_user_count: number;
  member_count: number;
  topics: string[];
  last_summarized_at: string | null;
};

type NextStep =
  | "auto_resolve"
  | "escalate_founder"
  | "route_specialist"
  | "no_op";

type Triage = {
  total_cards: number;
  runs: number;
  funnel: Record<NextStep, number>;
  severity: { P0: number; P1: number; P2: number; P3: number };
  specialist_routes: { slug: string; count: number }[];
  low_confidence: number;
  last_triage_at: string | null;
};

type Payload = {
  generic?: boolean;
  connected: boolean;
  kpis: {
    channels_summarized: number;
    message_volume_7d: number;
    distinct_people: number;
    oldest_summary_at: string | null;
  };
  top_themes: string[];
  channels: ChannelRow[];
  attention: AttentionItem[];
  triage?: Triage | null;
};

const connectState = (
  <EmptyState title="Connect Slack to see your support pulse">
    Connect Slack so support-lead can summarize and triage your support
    channels. Once it&apos;s connected and channels are summarized, this panel
    shows message volume, active people, and the top themes across your
    channels.
  </EmptyState>
);

const INK = "#0e0f11";
const MUTED = "#595959";
const WARN = "#8a6d00";
const BORDER = "#f0f0f0";
const SOFT = "#f7f4ee";

function FunnelKpi({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: "warn";
}) {
  return (
    <div
      className="rounded-2xl border bg-white px-4 py-4"
      style={{ borderColor: BORDER }}
    >
      <div
        className="text-[11px] uppercase tracking-[0.06em]"
        style={{ color: "#8a8a8a" }}
      >
        {label}
      </div>
      <div
        className="mt-2 text-[24px] font-semibold tabular-nums leading-none"
        style={{ color: tone === "warn" ? WARN : INK }}
      >
        {value}
      </div>
      {meta ? (
        <div className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
          {meta}
        </div>
      ) : null}
    </div>
  );
}

const FUNNEL_ROWS: { key: NextStep; label: string; help: string }[] = [
  { key: "auto_resolve", label: "Auto-resolved", help: "low-stakes + policy-clear" },
  { key: "escalate_founder", label: "Escalated to you", help: "needs your authority" },
  { key: "route_specialist", label: "Routed to a specialist", help: "another agent's tools" },
  { key: "no_op", label: "No action needed", help: "noise / already handled" },
];

const SEV_META: Record<
  "P0" | "P1" | "P2" | "P3",
  { label: string; bg: string; fg: string }
> = {
  P0: { label: "P0 · urgent", bg: "#fdecec", fg: "#cb2029" },
  P1: { label: "P1 · high", bg: "#fbf3e3", fg: "#8a6d00" },
  P2: { label: "P2 · normal", bg: "#eef4f1", fg: "#167f50" },
  P3: { label: "P3 · low", bg: SOFT, fg: MUTED },
};

const SPECIALIST_LABEL: Record<string, string> = {
  "dispute-response": "dispute-response",
  engineer: "engineer",
  verification: "verification",
  other: "other specialist",
};

function TriageFunnel({ t }: { t: Triage }) {
  const total = t.total_cards;
  return (
    <section>
      <SectionTitle>Escalation funnel · last 7 days</SectionTitle>
      {total === 0 ? (
        <div
          className="rounded-xl border border-dashed px-4 py-3 text-[12px]"
          style={{ borderColor: "#e5e7eb", color: "#a8a8a8" }}
        >
          No signals triaged in the last 7 days. As support-lead triages inbound
          across your channels, the routing + severity breakdown lands here.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {}
          <div
            className="overflow-hidden rounded-2xl border bg-white px-4 py-3"
            style={{ borderColor: BORDER }}
          >
            <div
              className="mb-2 text-[11px] uppercase tracking-[0.06em]"
              style={{ color: "#8a8a8a" }}
            >
              {num(total)} signal{total === 1 ? "" : "s"} ·{" "}
              {num(t.runs)} triage run{t.runs === 1 ? "" : "s"}
            </div>
            <div className="flex flex-col gap-2">
              {FUNNEL_ROWS.map((r) => {
                const v = t.funnel[r.key] ?? 0;
                const w = total > 0 ? Math.round((v / total) * 100) : 0;
                return (
                  <div key={r.key} className="flex items-center gap-3">
                    <div className="w-40 shrink-0">
                      <div
                        className="text-[13px] font-medium"
                        style={{ color: INK }}
                      >
                        {r.label}
                      </div>
                      <div className="text-[11px]" style={{ color: "#9a9a9a" }}>
                        {r.help}
                      </div>
                    </div>
                    {}
                    <div
                      className="h-2 flex-1 overflow-hidden rounded-full"
                      style={{ background: SOFT }}
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${w}%`, background: "#c9c2b4" }}
                      />
                    </div>
                    <div
                      className="w-14 shrink-0 text-right text-[13px] font-semibold tabular-nums"
                      style={{ color: INK }}
                    >
                      {num(v)}
                      <span
                        className="ml-1 text-[11px] font-normal"
                        style={{ color: MUTED }}
                      >
                        {w}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div
              className="rounded-2xl border bg-white px-4 py-3"
              style={{ borderColor: BORDER }}
            >
              <div
                className="mb-2 text-[11px] uppercase tracking-[0.06em]"
                style={{ color: "#8a8a8a" }}
              >
                Severity mix
              </div>
              <div className="flex flex-wrap gap-2">
                {(["P0", "P1", "P2", "P3"] as const).map((s) => {
                  const m = SEV_META[s];
                  return (
                    <span
                      key={s}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium"
                      style={{ borderColor: BORDER, background: m.bg, color: m.fg }}
                    >
                      {m.label}
                      <span className="tabular-nums">{num(t.severity[s])}</span>
                    </span>
                  );
                })}
              </div>
            </div>

            <div
              className="rounded-2xl border bg-white px-4 py-3"
              style={{ borderColor: BORDER }}
            >
              <div
                className="mb-2 text-[11px] uppercase tracking-[0.06em]"
                style={{ color: "#8a8a8a" }}
              >
                Confidence gate
              </div>
              <div className="text-[13px]" style={{ color: INK }}>
                <span className="text-[20px] font-semibold tabular-nums">
                  {num(t.low_confidence)}
                </span>{" "}
                <span style={{ color: MUTED }}>
                  card{t.low_confidence === 1 ? "" : "s"} below the 0.6
                  auto-resolve threshold, so not auto-resolved.
                </span>
              </div>
            </div>
          </div>

          {}
          {t.specialist_routes.length > 0 && (
            <div
              className="rounded-2xl border bg-white px-4 py-3"
              style={{ borderColor: BORDER }}
            >
              <div
                className="mb-2 text-[11px] uppercase tracking-[0.06em]"
                style={{ color: "#8a8a8a" }}
              >
                Recommended specialist routes
              </div>
              <div className="flex flex-col gap-2">
                {t.specialist_routes.map((r) => (
                  <div
                    key={r.slug}
                    className="flex items-center justify-between text-[13px]"
                  >
                    <span style={{ color: INK }}>
                      {SPECIALIST_LABEL[r.slug] ?? r.slug}
                    </span>
                    <span
                      className="tabular-nums font-semibold"
                      style={{ color: MUTED }}
                    >
                      {num(r.count)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function SupportLeadDashboard() {
  const state = useAgentDashboard<Payload>("support-lead");
  return (
    <DashboardShell
      title="Support pulse"
      subtitle="Triage intake across your support channels, routed, never auto-executed."
      state={state}
      genericFallback={connectState}
      render={(d) => {
        if (!d.connected) {
          const hasTriage = (d.triage?.total_cards ?? 0) > 0;
          if (!hasTriage) return connectState;
          return (
            <div className="flex flex-col gap-5">
              {connectState}
              <TriageFunnel t={d.triage!} />
            </div>
          );
        }
        const k = d.kpis;
        return (
          <div className="flex flex-col gap-5">
            {}
            <AttentionList items={d.attention} />

            {}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <FunnelKpi
                label="Channels summarized"
                value={num(k.channels_summarized)}
                meta={
                  k.oldest_summary_at
                    ? `oldest ${ago(k.oldest_summary_at)}`
                    : undefined
                }
              />
              <FunnelKpi
                label="Message volume · 7d"
                value={num(k.message_volume_7d)}
                meta={`${num(k.distinct_people)} across channels`}
              />
              <FunnelKpi
                label="Active people by channel · 7d"
                value={num(k.distinct_people)}
              />
              <FunnelKpi
                label="Needs your call"
                value={num(d.attention.length)}
                meta={d.attention.length > 0 ? "in attention list" : "all clear"}
                tone={d.attention.length > 0 ? "warn" : undefined}
              />
            </div>

            {}
            {d.triage ? (
              <TriageFunnel t={d.triage} />
            ) : null}

            <section
              className="rounded-2xl border px-4 py-3 text-[12px] leading-relaxed"
              style={{
                borderColor: BORDER,
                background: SOFT,
                color: MUTED,
              }}
            >
              <span className="font-semibold" style={{ color: WARN }}>
                ▲ Routed, never auto-executed.
              </span>{" "}
              support-lead is T1 triage. It summarizes and routes inbound
              support, but refunds, bans, and writes always require your approval
              in chat. The funnel above shows how it routed each signal; nothing
              acts without your call.
            </section>

            {}
            {d.top_themes.length > 0 && (
              <section>
                <SectionTitle>Top themes · last 7 days</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {d.top_themes.map((t, i) => (
                    <span
                      key={i}
                      className="inline-block rounded-md border px-2 py-1 text-[11px]"
                      style={{
                        borderColor: BORDER,
                        background: SOFT,
                        color: MUTED,
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {}
            <section>
              <SectionTitle>Per-channel pulse · 7d</SectionTitle>
              {d.channels.length === 0 ? (
                <div
                  className="rounded-xl border border-dashed px-4 py-3 text-[12px]"
                  style={{ borderColor: "#e5e7eb", color: "#a8a8a8" }}
                >
                  No summarized channels yet.
                </div>
              ) : (
                <div
                  className="overflow-hidden rounded-2xl border bg-white"
                  style={{ borderColor: BORDER }}
                >
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr
                        className="border-b text-left text-[11px] uppercase tracking-[0.05em]"
                        style={{ borderColor: BORDER, color: "#8a8a8a" }}
                      >
                        <th className="px-3 py-2.5 font-semibold">Channel</th>
                        <th className="px-3 py-2.5 text-right font-semibold">
                          Msgs
                        </th>
                        <th className="px-3 py-2.5 text-right font-semibold">
                          People
                        </th>
                        <th className="px-3 py-2.5 text-right font-semibold">
                          Last summ.
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.channels.map((c) => (
                        <tr
                          key={c.channel_id}
                          className="border-b align-top last:border-0 hover:bg-[#fcfcfc]"
                          style={{ borderColor: BORDER }}
                        >
                          <td className="px-3 py-3">
                            <div
                              className="font-semibold"
                              style={{ color: INK }}
                            >
                              #{c.name}
                            </div>
                            {c.topics.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {c.topics.map((t, i) => (
                                  <span
                                    key={i}
                                    className="inline-block rounded-md border px-1.5 py-0.5 text-[11px]"
                                    style={{
                                      borderColor: BORDER,
                                      background: SOFT,
                                      color: MUTED,
                                    }}
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {num(c.message_count)}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {num(c.distinct_user_count)}
                          </td>
                          <td
                            className="px-3 py-3 text-right text-[12px]"
                            style={{ color: MUTED }}
                          >
                            {ago(c.last_summarized_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div
              className="text-center text-[11px]"
              style={{ color: "#9a9a9a" }}
            >
              Support pulse · 7-day window · agent never auto-executes refunds,
              bans, or writes
            </div>
          </div>
        );
      }}
    />
  );
}
