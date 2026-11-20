"use client";

import { useWorkspace } from "@/components/workspace/WorkspaceShell";

import {
  useAgentDashboard,
  DashboardShell,
  Kpi,
  KpiStrip,
  AttentionCard,
  EmptyState,
  Pill,
  ago,
  num,
  STRIPE_LIMITED_AGENTS,
  type AttentionItem,
} from "./dashboard-ui";

const CONNECTOR_AGENT_IMPACT: Record<string, number> = {
  stripe: STRIPE_LIMITED_AGENTS,
};

type ConnectorRow = {
  slug: string;
  label: string;
  connected: boolean;
};

type ThreadRow = {
  id: string;
  title: string;
  snippet: string;
  last_message_at: string | null;
  status: "pending" | "running" | "done" | "idle";
};

type Payload = {
  generic?: boolean;
  kpis: {
    pending: number;
    connected_count: number;
    runs_7d: number;
    last_active: string | null;
  };
  attention: AttentionItem[];
  connectors: ConnectorRow[];
  threads: ThreadRow[];
};

const STATUS_TONE: Record<
  ThreadRow["status"],
  { tone: "neutral" | "good" | "warn" | "bad"; label: string }
> = {
  pending: { tone: "warn", label: "Awaiting you" },
  running: { tone: "neutral", label: "Working" },
  done: { tone: "good", label: "Done" },
  idle: { tone: "neutral", label: "Idle" },
};

const emptyState = (
  <EmptyState title="Your approval inbox">
    Ask the operator anything about your business. It reads your DB, Stripe,
    Slack, repo, and tickets, and queues any write here for your one-click
    approval.
  </EmptyState>
);

function isConnectorNudge(a: AttentionItem): boolean {
  return /isn['’]t connected$/.test(a.title) || /^connect\b/i.test(a.ask ?? "");
}

export function OperatorDashboard() {
  const state = useAgentDashboard<Payload>("operator");
  const { openAgentTab } = useWorkspace();
  return (
    <DashboardShell
      title="Approval inbox"
      subtitle="What's waiting on your stamp, what's wired, and what we last talked about."
      state={state}
      genericFallback={emptyState}
      render={(d) => {
        const k = d.kpis;
        const nothing =
          k.pending === 0 &&
          k.connected_count === 0 &&
          k.runs_7d === 0 &&
          d.threads.length === 0;
        if (nothing) return emptyState;

        const totalConnectors = d.connectors.length;
        const connectedConnectors = d.connectors.filter(
          (c) => c.connected,
        ).length;
        const disconnected = d.connectors.find((c) => !c.connected) ?? null;

        const connectorNudges = d.attention.filter(isConnectorNudge);
        const queue = d.attention.filter((a) => !isConnectorNudge(a));
        const focused = queue[0] ?? null;
        const onDeck = queue.slice(1);

        return (
          <div className="flex flex-col gap-5">
            <KpiStrip>
              <Kpi label="Pending approvals" value={num(k.pending)} />
              <Kpi
                label="Connected systems"
                value={
                  totalConnectors > 0
                    ? `${connectedConnectors} of ${totalConnectors}`
                    : num(k.connected_count)
                }
              />
              <Kpi label="Operator runs · 7d" value={num(k.runs_7d)} />
              <Kpi label="Last active" value={ago(k.last_active)} />
            </KpiStrip>

            {}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
              {}
              <section className="min-w-0">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
                    Approval queue
                  </h3>
                  <span className="text-[12px] text-[#8a8a8a]">
                    {queue.length === 0
                      ? "all clear"
                      : `${queue.length} waiting · oldest first`}
                  </span>
                </div>

                {queue.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#e5e7eb] bg-white px-4 py-6 text-center text-[12px] text-[#8a8a8a]">
                    Nothing queued for approval. When the operator wants to file
                    a ticket or post to Slack on your behalf, it lands here for
                    your one-click stamp.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {}
                    {focused ? (
                      <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-[#595959]">
                          <span>
                            Decision <b className="text-[#0e0f11]">1</b> of{" "}
                            <b className="text-[#0e0f11]">{queue.length}</b>
                          </span>
                          <span className="inline-flex items-center gap-2 rounded-full border border-[#f0e2c0] bg-[#fdfaf0] px-2 py-0.5 text-[11px] font-medium text-[#9a7b1a]">
                            <span
                              aria-hidden="true"
                              className="inline-block h-1.5 w-1.5 rounded-full bg-[#9a7b1a]"
                            />
                            Proposed
                          </span>
                        </div>
                        <AttentionCard item={focused} onActed={state.refresh} />
                      </div>
                    ) : null}

                    {}
                    {onDeck.length > 0 ? (
                      <div className="mt-1">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
                          On deck · {onDeck.length} more
                        </div>
                        <div className="flex flex-col gap-2">
                          {onDeck.map((a, i) => (
                            <div
                              key={a.decision_id ?? i}
                              className="flex items-start justify-between gap-3 rounded-xl border border-[#e5e7eb] bg-white px-4 py-2.5 opacity-80"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-medium text-[#1f1f1f]">
                                  {a.title}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-[12px] text-[#595959]">
                                  {a.detail}
                                </div>
                              </div>
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  a.severity === "high"
                                    ? "bg-[#fdf2f1] text-[#c0392b]"
                                    : "bg-[#fdfaf0] text-[#9a7b1a]"
                                }`}
                              >
                                {a.severity === "high" ? "Overdue" : "Waiting"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>

              {}
              <aside className="flex min-w-0 flex-col gap-5">
                {}
                <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                  <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
                    Connected systems
                  </h3>
                  {d.connectors.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[#e5e7eb] px-3 py-2.5 text-[12px] text-[#a8a8a8]">
                      No systems wired yet. Connect them so the operator can read
                      your business.
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {d.connectors.map((c, i) => (
                        <div
                          key={c.slug}
                          className={`flex items-center justify-between gap-3 py-2 ${
                            i < d.connectors.length - 1
                              ? "border-b border-[#f0f0f0]"
                              : ""
                          }`}
                        >
                          <div className="flex min-w-0 flex-col">
                            <span className="text-[13px] font-medium text-[#1f1f1f]">
                              {c.label}
                            </span>
                            {!c.connected && CONNECTOR_AGENT_IMPACT[c.slug] ? (
                              <span className="text-[11px] text-[#9a7b1a]">
                                {CONNECTOR_AGENT_IMPACT[c.slug]} agents limited
                                until connected
                              </span>
                            ) : null}
                          </div>
                          {}
                          <span
                            className={`inline-flex shrink-0 items-center gap-2 text-[12px] font-semibold ${
                              c.connected
                                ? "text-[#167f50]"
                                : "text-[#cb2029]"
                            }`}
                          >
                            <span aria-hidden="true">
                              {c.connected ? "✓" : "✕"}
                            </span>
                            {c.connected ? "Connected" : "Disconnected"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {disconnected ? (
                    <div className="mt-3 rounded-lg border border-[#f3dada] bg-[#fdf6f6] px-3 py-2.5 text-[12px] text-[#595959]">
                      <b className="text-[#cb2029]">Heads up:</b>{" "}
                      {disconnected.label} is off, so anything the operator queues
                      against it can&apos;t run until you reconnect.
                    </div>
                  ) : null}
                </div>

                {}
                <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                  <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
                    Recent threads
                  </h3>
                  {d.threads.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[#e5e7eb] px-3 py-2.5 text-[12px] text-[#a8a8a8]">
                      No operator conversations yet. Start one in the chat on the
                      right.
                    </div>
                  ) : (
                    <ul className="flex flex-col">
                      {d.threads.map((t, i) => {
                        const s = STATUS_TONE[t.status] ?? STATUS_TONE.idle;
                        const open = () => {
                          void openAgentTab("operator", { threadId: t.id, push: true });
                        };
                        return (
                          <li
                            key={t.id}
                            onClick={open}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                open();
                              }
                            }}
                            tabIndex={0}
                            role="button"
                            aria-label={`Open conversation: ${t.title}`}
                            className={`cursor-pointer py-2.5 transition-colors hover:bg-[#faf9f5] focus:bg-[#faf9f5] focus:outline-none ${
                              i < d.threads.length - 1
                                ? "border-b border-[#f0f0f0]"
                                : ""
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1f1f1f]">
                                {t.title}
                              </span>
                              <Pill tone={s.tone}>{s.label}</Pill>
                            </div>
                            {t.snippet ? (
                              <div className="mt-0.5 truncate text-[12px] text-[#8a8a8a]">
                                {t.snippet}
                              </div>
                            ) : null}
                            <div className="mt-0.5 text-[11px] text-[#9a9a9a]">
                              {ago(t.last_message_at)}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {}
                {connectorNudges.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {connectorNudges.map((a, i) => (
                      <AttentionCard
                        key={i}
                        item={a}
                        onActed={state.refresh}
                      />
                    ))}
                  </div>
                ) : null}
              </aside>
            </div>
          </div>
        );
      }}
    />
  );
}
