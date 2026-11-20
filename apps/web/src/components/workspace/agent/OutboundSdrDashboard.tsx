"use client";

import {
  useAgentDashboard,
  DashboardShell,
  Kpi,
  KpiStrip,
  SectionTitle,
  AttentionList,
  EmptyState,
  Pill,
  num,
  ago,
  type AttentionItem,
} from "./dashboard-ui";

type PendingDraft = {
  decision_id: string;
  recipient: string;
  subject: string;
  preview: string;
  emitted_at: string | null;
};

type RecentSend = {
  recipient: string;
  sent_at: string | null;
};

type Payload = {
  generic?: boolean;
  sender_connected: boolean;
  kpis: {
    pending_count: number;
    sent_24h: number | null;
    daily_cap: number | null;
    suppressed_count: number;
  };
  pending: PendingDraft[];
  recent_sends: RecentSend[];
  attention: AttentionItem[];
};

const genericFallback = (
  <EmptyState title="Connect an email sender to start outreach">
    Once an email sender is connected, outbound-sdr drafts personalized
    first-touch emails here for your approval. Use the chat on the right to
    direct it.
  </EmptyState>
);

export function OutboundSdrDashboard() {
  const state = useAgentDashboard<Payload>("outbound-sdr");
  return (
    <DashboardShell
      title="Outreach"
      subtitle="Drafts waiting to send, and your daily send budget."
      state={state}
      genericFallback={genericFallback}
      render={(d) => {
        const k = d.kpis;
        const capLabel =
          k.daily_cap == null ? "No cap" : num(k.daily_cap);

        if (!d.sender_connected && d.pending.length === 0) {
          return (
            <div className="flex flex-col gap-5">
              <AttentionList items={d.attention} />
              <EmptyState title="Connect an email sender to start outreach">
                Drafts will queue here for your approval. Ask in the chat to
                connect a sender, then have outbound-sdr draft your first batch.
              </EmptyState>
            </div>
          );
        }

        return (
          <div className="flex flex-col gap-5">
            <AttentionList items={d.attention} />

            {}
            <KpiStrip>
              <Kpi label="Drafts pending" value={num(k.pending_count)} />
              <Kpi
                label="Sent (24h)"
                value={k.sent_24h == null ? "-" : num(k.sent_24h)}
              />
              <Kpi label="Daily cap" value={capLabel} />
              <Kpi label="Suppressed" value={num(k.suppressed_count)} />
            </KpiStrip>

            {}
            <section>
              <SectionTitle>Drafts awaiting your approval</SectionTitle>
              {d.pending.length === 0 ? (
                <EmptyState title="No drafts waiting">
                  When outbound-sdr finds a well-fit prospect, the drafted
                  first-touch email lands here for your approval. Ask it in the
                  chat to draft a batch.
                </EmptyState>
              ) : (
                <div className="flex flex-col gap-2">
                  {d.pending.map((p) => (
                    <div
                      key={p.decision_id}
                      className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-semibold text-[#1f1f1f]">
                            {p.recipient}
                          </div>
                          <div className="truncate text-[12px] font-medium text-[#595959]">
                            {p.subject || "(no subject)"}
                          </div>
                        </div>
                        <Pill tone="warn">Awaiting approval</Pill>
                      </div>
                      {p.preview ? (
                        <div className="mt-1.5 line-clamp-2 text-[12px] text-[#8a8a8a]">
                          {p.preview}
                        </div>
                      ) : null}
                      <div className="mt-1.5 text-[11px] text-[#a8a8a8]">
                        Drafted {ago(p.emitted_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {}
            {d.recent_sends.length > 0 && (
              <section>
                <SectionTitle>Recent sends</SectionTitle>
                <div className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[#e5e7eb] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                        <th className="px-3 py-2 font-medium">Recipient</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Sent
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.recent_sends.map((s, i) => (
                        <tr
                          key={i}
                          className="border-b border-[#f0ede5] last:border-0"
                        >
                          <td className="truncate px-3 py-2 font-medium text-[#1f1f1f]">
                            {s.recipient || "(unknown)"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-[#595959]">
                            {ago(s.sent_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        );
      }}
    />
  );
}
