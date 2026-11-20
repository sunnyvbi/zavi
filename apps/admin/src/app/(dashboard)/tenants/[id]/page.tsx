"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import { HealthBadge, type AgentHealth } from "@/components/admin/HealthBadge";
import { ReadinessCard } from "@/components/admin/ReadinessCard";
import { CgoAutopilotCard } from "@/components/admin/CgoAutopilotCard";
import { BuildReplayCard } from "@/components/admin/BuildReplayCard";
import { TenantKindToggle } from "@/components/admin/TenantKindToggle";
import { TenantSignupSource, type TenantAttribution } from "@/components/admin/TenantSignupSource";
import { TenantDisableCard, TenantDisabledBanner, type DisabledState } from "@/components/admin/TenantDisableCard";

type Summary = {
  tenant: { id: string; slug: string; display_name: string };
  runs_7d: { total: number; errors: number };
  feedback_7d: Array<{
    agent_slug: string;
    thumbs_up: number;
    thumbs_down: number;
    total: number;
    nps: number;
    recent_negative_comments: string[];
  }>;
};

type AgentRow = {
  agent_slug: string;
  runs: number;
  ok_rate: number;
  errors: number;
  cost_usd: number;
  latest_run: string | null;
};

type ConnectorSummary = {
  key: string;
  label: string;
  connected: boolean;
  connected_at: string | null;
  detail: string | null;
};
type TenantProfile = {
  attribution?: TenantAttribution | null;
  tenant: {
    id: string;
    slug: string;
    display_name: string;
    tier: string | null;
    kind: string | null;
    created_at: string;
    product_url: { href: string; label: string } | null;
    show_in_public_feed: boolean | null;
    rar_weekly_threshold: number | null;
    disabled_at?: string | null;
    disabled_reason?: string | null;
  };
  primary_owner: { user_id: string; email: string | null; name: string | null; joined_at: string | null } | null;
  owner_count: number;
  members: { total: number };
  signup: {
    path: string;
    evidence: string | null;
    onboarded_at: string | null;
    company_domain: string | null;
    enrichment_outcome: string | null;
    enrichment_at: string | null;
  } | null;
  connectors: ConnectorSummary[];
  billing: {
    plan: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    grandfathered: boolean;
    stripe_customer_id: string | null;
    credits: {
      included_allowance: number;
      included_used: number;
      included_remaining: number;
      purchased_balance: number;
      reserved: number;
      period_end: string | null;
    } | null;
    daily_cap_usd: number | null;
  } | null;
  usage: {
    last_active_at: string | null;
    last_active_source: string | null;
    surfaces: Array<{ surface: string; runs: number; last_at: string | null }>;
    runs_30d: number;
    agents_enabled: number;
  };
  degraded: string[];
};

type ConnectionRow = {
  source: "connector" | "mcp" | "resource" | "operator_db";
  key: string;
  label: string;
  status: string;
  connected_at: string | null;
  detail: string | null;
};
type ChatItem = {
  id: string;
  agent_slug: string;
  title: string | null;
  created_at: string;
  last_message_at: string;
  messages: number;
};
type ChatErrorItem = {
  run_id: string;
  agent_slug: string;
  status: string;
  error: string;
  at: string | null;
};
type TenantActivity = {
  connections: ConnectionRow[];
  chats: { total: number; items: ChatItem[] };
  chat_errors: { total: number; items: ChatErrorItem[] };
  list_cap: number;
  degraded: string[];
};

type NeedsHelpItem = {
  key: string;
  signal: "pending_decision" | "errored" | "stuck" | "low_score" | "task" | "needs_answer";
  severity: number;
  agent_slug: string | null;
  title: string;
  why: string;
  run_id: string | null;
  decision_id: string | null;
  task_id: string | null;
  decision_class: string | null;
  body: Record<string, unknown> | null;
  detail: Array<{ label: string; value: string }> | null;
  chips: Array<{ label: string; tone: "good" | "warn" | "neutral" }> | null;
  approve_hint: string | null;
  reject_hint: string | null;
  at: string | null;
  actions: string[];
};

export default function AdminTenantPage() {
  return <Body />;
}

function Body() {
  const params = useParams<{ id: string }>();
  const tenantId = params?.id;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [activity, setActivity] = useState<TenantActivity | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [health, setHealth] = useState<Map<string, AgentHealth>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<
    Map<string, { provider: string; model: string; source: string }>
  >(new Map());
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [needsHelp, setNeedsHelp] = useState<NeedsHelpItem[] | null>(null);

  const loadNeedsHelp = async (tid: string) => {
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tid}/needs-help`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setNeedsHelp((b.items ?? []) as NeedsHelpItem[]);
    } catch {
    }
  };

  async function resolveTask(taskId: string) {
    setBusy(`task:${taskId}`);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/admin-tasks/${taskId}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      if (tenantId) await loadNeedsHelp(tenantId);
    } catch (e) {
      setError(`resolve task: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function decideDecision(
    decisionId: string,
    action: "approve" | "reject",
    editedBody?: Record<string, unknown>,
  ) {
    setBusy(`decision:${decisionId}`);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/decisions/${decisionId}/decide`, {
        method: "POST",
        body: JSON.stringify(editedBody ? { action, edited_body: editedBody } : { action }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      if (tenantId) await loadNeedsHelp(tenantId);
    } catch (e) {
      setError(`decision ${action}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const loadEngine = async (tid: string) => {
    try {
      const res = await adminApiFetch(`/api/admin/engine-override?tenant_id=${tid}`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const m = new Map<string, { provider: string; model: string; source: string }>();
      for (const a of (b.agents ?? []) as Array<{
        slug: string;
        effective_provider: string;
        effective_model: string;
        source: string;
      }>) {
        m.set(a.slug, {
          provider: a.effective_provider,
          model: a.effective_model,
          source: a.source,
        });
      }
      setEngine(m);
      setModelOptions((b.model_options ?? {}) as Record<string, string[]>);
    } catch {
    }
  };

  async function setEngineProvider(slug: string, provider: string | null) {
    const model = provider ? modelOptions[provider]?.[0] : undefined;
    if (provider && !model) {
      setError(
        `${slug} engine: no model registered for provider "${provider}" — reload the page, or set it from /engine.`,
      );
      return;
    }
    setBusy(`${slug}:engine`);
    setError(null);
    try {
      const res = provider
        ? await adminApiFetch(`/api/admin/engine-override`, {
            method: "POST",
            body: JSON.stringify({
              tenant_id: tenantId,
              agent_slug: slug,
              provider,
              model,
            }),
          })
        : await adminApiFetch(`/api/admin/engine-override`, {
            method: "DELETE",
            body: JSON.stringify({ tenant_id: tenantId, agent_slug: slug }),
          });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      if (tenantId) await loadEngine(tenantId);
    } catch (e) {
      setError(`${slug} engine: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const loadActivity = async (tid: string) => {
    setActivity(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tid}/activity`);
      if (!res.ok) return;
      const b = await res.json().catch(() => null);
      if (b) setActivity(b as TenantActivity);
    } catch {
    }
  };

  useEffect(() => {
    if (!tenantId) return;
    void loadEngine(tenantId);
    void loadNeedsHelp(tenantId);
    void loadActivity(tenantId);
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setHealth(new Map());
    setProfile(null);
    (async () => {
      try {
        const [sRes, aRes, hRes, pRes] = await Promise.all([
          adminApiFetch(`/api/admin/tenants/${tenantId}`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/agents`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/agent-health`).catch(() => null),
          adminApiFetch(`/api/admin/tenants/${tenantId}/profile`).catch(() => null),
        ]);
        const sBody = await sRes.json().catch(() => ({}));
        const aBody = await aRes.json().catch(() => ({}));
        if (!sRes.ok) throw new Error(sBody?.error?.message ?? `HTTP ${sRes.status}`);
        if (!aRes.ok) throw new Error(aBody?.error?.message ?? `HTTP ${aRes.status}`);
        if (cancelled) return;
        setSummary(sBody as Summary);
        setAgents((aBody.agents ?? []) as AgentRow[]);
        if (hRes && hRes.ok) {
          const hBody = await hRes.json().catch(() => ({}));
          const m = new Map<string, AgentHealth>();
          for (const h of (hBody.agents ?? []) as AgentHealth[]) m.set(h.slug, h);
          setHealth(m);
        }
        if (pRes && pRes.ok) {
          const pBody = await pRes.json().catch(() => null);
          if (pBody && !cancelled) setProfile(pBody as TenantProfile);
        }
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </div>
      </div>
    );
  }
  if (!summary || !agents) {
    return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  }

  const fbBySlug = new Map(summary.feedback_7d.map((f) => [f.agent_slug, f]));

  return (
    <div className="max-w-5xl mx-auto p-6">
      <a href="/tenants" className="text-sm text-slate-500 hover:underline">
        ← all tenants
      </a>
      <div className="mt-2 flex items-baseline gap-3">
          <h1 className="font-display font-semibold text-3xl text-slate-900">{summary.tenant.display_name}</h1>
          <code className="text-sm text-slate-500">{summary.tenant.slug}</code>
        </div>
        <div className="mt-1 text-sm text-slate-600">
          Last 7d — {summary.runs_7d.total} runs · {summary.runs_7d.errors} errors
        </div>

        {}
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <span className="rounded px-2 py-0.5 bg-slate-900 text-white">Overview</span>
          <a href={`/tenants/${tenantId}/coverage`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
            Coverage
          </a>
          <a href={`/tenants/${tenantId}/billing`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
            Credits &amp; pricing
          </a>
          <a href={`/tenants/${tenantId}/console`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
            Agent console
          </a>
        </div>

        {profile && <TenantSignupSource attribution={profile.attribution} />}
        {profile && <ProfileSections key={profile.tenant.id} profile={profile} />}

        {activity && <ActivitySections activity={activity} tenantId={tenantId} />}

        {tenantId && <SetGoalCard tenantId={tenantId} />}

        {}
        {needsHelp && needsHelp.length > 0 && (
          <>
            <h2 className="mt-8 mb-2 text-xs uppercase tracking-[0.16em] text-rose-700">
              Needs help · {needsHelp.length}
            </h2>
            <div className="space-y-2">
              {needsHelp.map((it) => (
                <NeedsHelpCard
                  key={it.key}
                  item={it}
                  busy={busy}
                  tenantId={tenantId!}
                  onSetEngineProvider={setEngineProvider}
                  onResolveTask={resolveTask}
                  onDecide={decideDecision}
                />
              ))}
            </div>
          </>
        )}

        <h2 className="mt-8 mb-3 text-xs uppercase tracking-[0.16em] text-slate-500">
          Agents
        </h2>
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-4 py-2.5 w-8">Health</th>
                <th className="text-left px-4 py-2.5">Agent</th>
                <th className="text-right px-4 py-2.5">Runs 7d</th>
                <th className="text-right px-4 py-2.5">OK rate</th>
                <th className="text-right px-4 py-2.5">Errors</th>
                <th className="text-right px-4 py-2.5">$ 7d</th>
                <th className="text-right px-4 py-2.5">NPS</th>
                <th className="text-right px-4 py-2.5">Latest</th>
                <th className="text-left px-4 py-2.5">Engine</th>
                <th className="text-right px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const fb = fbBySlug.get(a.agent_slug);
                const eng = engine.get(a.agent_slug);
                const overridden = eng?.source === "tenant_override";
                return (
                  <Fragment key={a.agent_slug}>
                  <tr className="border-t border-slate-100">
                    <td className="px-4 py-2.5">
                      <HealthBadge health={health.get(a.agent_slug)} />
                    </td>
                    <td className="px-4 py-2.5">
                      <a
                        href={`/tenants/${tenantId}/agents/${a.agent_slug}`}
                        className="text-slate-900 hover:underline"
                      >
                        {a.agent_slug}
                      </a>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{a.runs}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{Math.round(a.ok_rate * 100)}%</td>
                    <td className="px-4 py-2.5 text-right font-mono">{a.errors}</td>
                    <td className="px-4 py-2.5 text-right font-mono">${a.cost_usd.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {fb ? `${fb.thumbs_up}/${fb.thumbs_down}` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm text-slate-500">
                      {a.latest_run ? new Date(a.latest_run).toLocaleString() : "—"}
                    </td>
                    {}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={overridden ? eng?.provider ?? "" : ""}
                          onChange={(e) =>
                            void setEngineProvider(a.agent_slug, e.target.value || null)
                          }
                          disabled={
                            busy === `${a.agent_slug}:engine` ||
                            Object.keys(modelOptions).length === 0
                          }
                          title={
                            eng
                              ? `${eng.provider} · ${eng.model} (${overridden ? "tenant override" : "agent default"})`
                              : ""
                          }
                          className={`rounded border px-1.5 py-0.5 text-xs disabled:opacity-40 ${
                            overridden
                              ? "border-amber-300 bg-amber-50 text-amber-900"
                              : "border-slate-200 bg-white text-slate-600"
                          }`}
                        >
                          {}
                          <option value="">
                            {eng && !overridden ? `${eng.provider} (default)` : "default"}
                          </option>
                          {Object.keys(modelOptions).map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        {busy === `${a.agent_slug}:engine` && (
                          <span className="text-xs text-slate-400">…</span>
                        )}
                      </div>
                    </td>
                    {}
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setNoteOpen((cur) => (cur === a.agent_slug ? null : a.agent_slug))}
                        className="text-sm text-slate-600 hover:text-slate-900 hover:underline"
                        aria-expanded={noteOpen === a.agent_slug}
                      >
                        {noteOpen === a.agent_slug ? "close" : "✎ note"}
                      </button>
                    </td>
                  </tr>
                  {noteOpen === a.agent_slug && tenantId && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={10} className="px-4 py-3">
                        <NoteInline
                          tenantId={tenantId}
                          slug={a.agent_slug}
                          onDone={() => setNoteOpen(null)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {summary.feedback_7d.some((f) => f.recent_negative_comments.length > 0) && (
          <>
            <h2 className="mt-8 mb-3 text-xs uppercase tracking-[0.16em] text-slate-500">
              Recent operator complaints (last 7d)
            </h2>
            <div className="space-y-2">
            {summary.feedback_7d
              .filter((f) => f.recent_negative_comments.length > 0)
              .map((f) => (
                <div key={f.agent_slug} className="rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="text-sm text-amber-900 mb-1">
                    {f.agent_slug} · {f.thumbs_down} 👎
                  </div>
                  <ul className="text-sm text-amber-900 space-y-0.5 list-disc pl-5">
                    {f.recent_negative_comments.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "rose" | "blue" }) {
  const cls = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    rose: "bg-rose-100 text-rose-800",
    blue: "bg-blue-100 text-blue-800",
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="glass-card p-4">
      <div className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-400">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-800">{children}</span>
    </div>
  );
}

function ProfileSections({ profile }: { profile: TenantProfile }) {
  const t = profile.tenant;
  const b = profile.billing;
  const s = profile.signup;
  const o = profile.primary_owner;
  const [readinessRefreshKey, setReadinessRefreshKey] = useState(0);
  const [disabledState, setDisabledState] = useState<DisabledState>({
    at: t.disabled_at ?? null,
    reason: t.disabled_reason ?? null,
  });

  return (
    <div className="mt-5 space-y-3">
      <TenantDisabledBanner
        tenantId={t.id}
        workspaceName={t.display_name}
        state={disabledState}
        onChange={setDisabledState}
      />

      {profile.degraded.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Some sections failed to load: {profile.degraded.join(", ")}. This is a load failure, not absent data.
        </div>
      )}

      {}
      <ReadinessCard tenantId={t.id} refreshKey={readinessRefreshKey} />

      <CgoAutopilotCard tenantId={t.id} />

      <BuildReplayCard tenantId={t.id} />

      {}
      <CompanyFactsCard
        tenantId={t.id}
        onFactsSaved={() => setReadinessRefreshKey((k) => k + 1)}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {}
        <Card title="Identity">
          <Field label="Tier">{t.tier ? <Chip tone="blue">{t.tier}</Chip> : "—"}</Field>
          <Field label="Kind"><TenantKindToggle tenantId={t.id} initialKind={t.kind} /></Field>
          <Field label="Status">
            <TenantDisableCard
              tenantId={t.id}
              workspaceName={t.display_name}
              state={disabledState}
              onChange={setDisabledState}
            />
          </Field>
          <Field label="Created">{new Date(t.created_at).toLocaleDateString()}</Field>
          <Field label="Product URL">
            {t.product_url ? (
              <a href={t.product_url.href} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                {t.product_url.label}
              </a>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Public feed">{t.show_in_public_feed == null ? "—" : t.show_in_public_feed ? "yes" : "no"}</Field>
          <Field label="RaR / wk">{t.rar_weekly_threshold ?? "—"}</Field>
        </Card>

        {}
        <Card title="Owner & members">
          <Field label="Owner">{o?.name || o?.email ? o.name ?? "—" : "—"}</Field>
          <Field label="Email">
            {o?.email ? (
              <a href={`mailto:${o.email}`} className="text-sm text-blue-700 hover:underline">
                {o.email}
              </a>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Joined">{o?.joined_at ? new Date(o.joined_at).toLocaleDateString() : "—"}</Field>
          <Field label="Owners">{profile.owner_count}</Field>
          <Field label="Members">{profile.members.total}</Field>
        </Card>

        {}
        <Card title="Signup">
          <Field label="Path">
            {s ? (
              <span className="inline-flex items-center gap-1.5">
                <Chip tone={s.path === "slack-first" ? "green" : s.path === "web-wizard" ? "blue" : "slate"}>{s.path}</Chip>
                <span className="text-xs text-slate-400">inferred{s.evidence ? ` · ${s.evidence}` : ""}</span>
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Onboarded">{s?.onboarded_at ? new Date(s.onboarded_at).toLocaleDateString() : "—"}</Field>
          <Field label="Company domain">{s?.company_domain ?? "—"}</Field>
          <Field label="Enrichment">
            {s?.enrichment_outcome ? `${s.enrichment_outcome}${s.enrichment_at ? ` · ${relTime(s.enrichment_at)}` : ""}` : "—"}
          </Field>
        </Card>

        {}
        <Card title="Billing">
          {b ? (
            <>
              <Field label="Plan">
                <span className="inline-flex items-center gap-1.5">
                  <Chip tone="blue">{b.plan}</Chip>
                  <Chip tone={b.status === "active" || b.status === "trialing" ? "green" : b.status === "past_due" ? "rose" : "slate"}>
                    {b.status}
                  </Chip>
                  {b.cancel_at_period_end && <Chip tone="amber">cancels</Chip>}
                  {b.grandfathered && <Chip tone="slate">grandfathered</Chip>}
                </span>
              </Field>
              <Field label="Period end">{b.current_period_end ? new Date(b.current_period_end).toLocaleDateString() : "—"}</Field>
              <Field label="Credits">
                {b.credits ? `${b.credits.included_remaining}/${b.credits.included_allowance} incl · ${b.credits.purchased_balance} purch` : "—"}
              </Field>
              <Field label="Daily cap">{b.daily_cap_usd != null ? `$${b.daily_cap_usd}` : "—"}</Field>
              {b.stripe_customer_id && (
                <Field label="Stripe">
                  <span className="font-mono text-xs text-slate-500">{b.stripe_customer_id}</span>
                </Field>
              )}
            </>
          ) : (
            <div className="text-sm text-slate-400">No billing record.</div>
          )}
        </Card>

        {}
        <Card title="Usage">
          <Field label="Last active">{relTime(profile.usage.last_active_at)}</Field>
          <Field label="Runs (30d)">{profile.usage.runs_30d}</Field>
          <Field label="Agents enabled">{profile.usage.agents_enabled}</Field>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {profile.usage.surfaces.length > 0 ? (
              profile.usage.surfaces.map((sf) => (
                <Chip key={sf.surface} tone="slate">
                  {sf.surface} · {sf.runs}
                </Chip>
              ))
            ) : (
              <span className="text-sm text-slate-400">no runs in 30d</span>
            )}
          </div>
        </Card>

        {}
        <Card title="Connectors">
          {profile.connectors.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {profile.connectors.map((c) => (
                <span
                  key={c.key}
                  title={c.connected_at ? `connected ${relTime(c.connected_at)}` : c.detail ?? ""}
                >
                  <Chip tone={c.connected ? "green" : "slate"}>
                    {c.connected ? "●" : "○"} {c.label}
                  </Chip>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-400">No connectors wired.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ActivitySections({
  activity,
  tenantId,
}: {
  activity: TenantActivity;
  tenantId: string | undefined;
}) {
  const conn = activity.connections;
  const chats = activity.chats;
  const errs = activity.chat_errors;
  const statusTone = (s: string): "green" | "amber" | "slate" | "rose" =>
    s === "connected" || s === "enabled" || s === "ready"
      ? "green"
      : s === "pending" || s === "provisioning"
        ? "amber"
        : s === "failed" || s === "disabled"
          ? "rose"
          : "slate";

  return (
    <div className="mt-8 space-y-6">
      {activity.degraded.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Some detail lists failed to load: {activity.degraded.join(", ")}.
        </div>
      )}

      {}
      <div>
        <h2 className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">
          Connections · {conn.length}
        </h2>
        {conn.length > 0 ? (
          <div className="overflow-x-auto glass-card">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="px-4 py-2.5 text-left">Integration</th>
                  <th className="px-4 py-2.5 text-left">Type</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-left">Detail</th>
                  <th className="px-4 py-2.5 text-right">Connected</th>
                </tr>
              </thead>
              <tbody>
                {conn.map((c) => (
                  <tr key={c.key} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-900">{c.label}</td>
                    <td className="px-4 py-2 text-sm text-slate-500">{c.source}</td>
                    <td className="px-4 py-2">
                      <Chip tone={statusTone(c.status)}>{c.status}</Chip>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{c.detail ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm text-slate-500">
                      {c.connected_at ? new Date(c.connected_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="glass-card border-dashed p-4 text-sm text-slate-500">
            No connections.
          </div>
        )}
      </div>

      {}
      <div>
        <h2 className="mb-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-500">
          <span>
            Chats · {chats.total}
            {chats.total > chats.items.length && (
              <span className="ml-2 normal-case tracking-normal text-slate-400">
                showing recent {chats.items.length}
              </span>
            )}
          </span>
          <Link
            href={`/tenants/${tenantId}/threads`}
            className="normal-case tracking-normal text-sky-700 hover:underline"
          >
            read transcripts →
          </Link>
        </h2>
        {chats.items.length > 0 ? (
          <div className="overflow-x-auto glass-card">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="px-4 py-2.5 text-left">Agent</th>
                  <th className="px-4 py-2.5 text-left">Chat</th>
                  <th className="px-4 py-2.5 text-right">Msgs</th>
                  <th className="px-4 py-2.5 text-right">Started</th>
                  <th className="px-4 py-2.5 text-right">Last message</th>
                </tr>
              </thead>
              <tbody>
                {chats.items.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100 hover:bg-white/40">
                    <td className="px-4 py-2 text-slate-700">{c.agent_slug}</td>
                    <td className="px-4 py-2 text-slate-800">
                      <Link
                        href={`/tenants/${tenantId}/threads/${c.id}`}
                        className="hover:text-sky-700 hover:underline"
                      >
                        {c.title ?? <span className="text-slate-400">untitled</span>}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{c.messages}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm text-slate-500">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-sm text-slate-500">
                      {relTime(c.last_message_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="glass-card border-dashed p-4 text-sm text-slate-500">
            No chats yet.
          </div>
        )}
      </div>

      {}
      <div>
        <h2 className="mb-2 text-xs uppercase tracking-[0.16em] text-rose-700">
          Chat errors · {errs.total}
        </h2>
        {errs.items.length > 0 ? (
          <div className="space-y-2">
            {errs.items.map((e) => (
              <div key={e.run_id} className="rounded-md border border-rose-200 bg-rose-50 p-3">
                <div className="mb-1 flex items-center gap-2 text-sm text-rose-900">
                  <span>{e.agent_slug}</span>
                  <Chip tone="rose">{e.status}</Chip>
                  <span className="ml-auto text-xs text-rose-700">{e.at ? relTime(e.at) : "—"}</span>
                  <a href={`/runs/${e.run_id}`} className="text-sm text-blue-700 hover:underline">
                    open run →
                  </a>
                </div>
                <div className="whitespace-pre-wrap break-words text-sm text-rose-900">{e.error}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-card border-dashed p-4 text-sm text-slate-500">
            No chat errors. 🎉
          </div>
        )}
      </div>
    </div>
  );
}

const GROWTH_FUNCTIONS = [
  "acquisition",
  "activation",
  "retention",
  "revenue",
  "referral",
  "ops",
  "support",
] as const;

function SetGoalCard({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(false);
  const [fn, setFn] = useState<string>("retention");
  const [objective, setObjective] = useState("");
  const [metric, setMetric] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const tv = Number(target);
    if (!objective.trim() || !metric.trim() || !Number.isFinite(tv)) {
      setErr("Objective, target metric, and a numeric target value are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/coach/set-goal`, {
        method: "POST",
        body: JSON.stringify({
          function: fn,
          objective: objective.trim(),
          target_metric: metric.trim(),
          target_value: tv,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setMsg("Goal set — the planner will prefer it on the next run.");
      setObjective("");
      setMetric("");
      setTarget("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm uppercase tracking-[0.14em] text-blue-700 hover:underline"
      >
        {open ? "− set goal" : "+ set goal for this tenant"}
      </button>
      {open && (
        <div className="mt-2 glass-card p-4 space-y-2 max-w-2xl">
          <div className="flex gap-2">
            <select
              value={fn}
              onChange={(e) => setFn(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            >
              {GROWTH_FUNCTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <input
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              placeholder="target metric (e.g. activation rate)"
              className="flex-1 border rounded px-2 py-1 text-sm"
            />
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="target value"
              inputMode="decimal"
              className="w-32 border rounded px-2 py-1 text-sm"
            />
          </div>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Objective — what should this customer's fleet drive toward?"
            rows={2}
            maxLength={2000}
            className="w-full border rounded px-2 py-1 text-sm"
          />
          {err && <div className="text-sm text-rose-600">{err}</div>}
          {msg && <div className="text-sm text-emerald-700">{msg}</div>}
          <div className="text-right">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy ? "Saving…" : "Set goal"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NoteInline({
  tenantId,
  slug,
  onDone,
}: {
  tenantId: string;
  slug: string;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save() {
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/agents/${slug}/note`, {
        method: "POST",
        body: JSON.stringify({ body_markdown: body.trim() }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setOk(true);
      setBody("");
      setTimeout(onDone, 700);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-500">
        Steering note for <span>{slug}</span> — read on its next run (14-day decay).
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="e.g. Always confirm before sending money. Cap responses at 4 bullets."
        rows={2}
        maxLength={2000}
        className="w-full border rounded px-2 py-1 text-sm"
      />
      {err && <div className="text-sm text-rose-600">{err}</div>}
      {ok && <div className="text-sm text-emerald-700">Saved.</div>}
      <div className="text-right">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !body.trim()}
          className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}

function NeedsHelpCard({
  item,
  busy,
  tenantId,
  onSetEngineProvider,
  onResolveTask,
  onDecide,
}: {
  item: NeedsHelpItem;
  busy: string | null;
  tenantId: string;
  onSetEngineProvider: (slug: string, provider: string | null) => void;
  onResolveTask: (taskId: string) => void;
  onDecide: (decisionId: string, action: "approve" | "reject", editedBody?: Record<string, unknown>) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [editErr, setEditErr] = useState<string | null>(null);
  const decBusy = item.decision_id ? busy === `decision:${item.decision_id}` : false;
  const sevCls =
    item.severity >= 85
      ? "bg-rose-500"
      : item.severity >= 60
        ? "bg-amber-500"
        : "bg-slate-400";
  const has = (a: string) => item.actions.includes(a);

  return (
    <div className="glass-card p-3">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${sevCls}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-[0.12em] text-slate-400">
              {item.signal.replace("_", " ")}
            </span>
            <span className="text-sm font-medium text-slate-900 truncate">{item.title}</span>
          </div>
          <div className="text-sm text-slate-600 mt-0.5">{item.why}</div>
          {item.chips && item.chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.chips.map((c, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium ${
                    c.tone === "good"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : c.tone === "warn"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                  }`}
                >
                  <span aria-hidden>{c.tone === "good" ? "✓" : c.tone === "warn" ? "!" : "◆"}</span>
                  {c.label}
                </span>
              ))}
            </div>
          )}
          {item.detail && item.detail.length > 0 && (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              {item.detail.map((f, i) => (
                <Fragment key={i}>
                  <dt className="capitalize tracking-[0.02em] text-slate-400">{f.label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-slate-700">{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {(item.approve_hint || item.reject_hint) && (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              {item.approve_hint && (
                <Fragment>
                  <dt className="font-medium text-emerald-700">If approved</dt>
                  <dd className="min-w-0 text-slate-600">{item.approve_hint}</dd>
                </Fragment>
              )}
              {item.reject_hint && (
                <Fragment>
                  <dt className="font-medium text-rose-700">If rejected</dt>
                  <dd className="min-w-0 text-slate-600">{item.reject_hint}</dd>
                </Fragment>
              )}
            </dl>
          )}
          {item.decision_class && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-slate-400 hover:text-slate-600">
                Technical details
              </summary>
              <div className="mt-1 text-xs text-slate-400">{item.decision_class}</div>
            </details>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {has("approve") && item.decision_id && (
              <button
                type="button"
                onClick={() => onDecide(item.decision_id!, "approve")}
                disabled={decBusy}
                className="text-sm font-medium text-emerald-700 hover:underline disabled:opacity-40"
              >
                {decBusy ? "…" : "✓ approve"}
              </button>
            )}
            {has("reject") && item.decision_id && (
              <button
                type="button"
                onClick={() => onDecide(item.decision_id!, "reject")}
                disabled={decBusy}
                className="text-sm text-rose-700 hover:underline disabled:opacity-40"
              >
                ✕ reject
              </button>
            )}
            {has("edit") && item.decision_id && (
              <button
                type="button"
                onClick={() => {
                  setEditErr(null);
                  setEditText(JSON.stringify(item.body ?? {}, null, 2));
                  setEditOpen((o) => !o);
                }}
                className="text-sm text-violet-700 hover:underline"
              >
                {editOpen ? "close edit" : "✎ edit + approve"}
              </button>
            )}
            {has("open_run") && item.run_id && (
              <a href={`/runs/${item.run_id}`} className="text-sm text-blue-700 hover:underline">
                open thread →
              </a>
            )}
            {has("open_decision") && (
              <a href={`/decisions`} className="text-sm text-blue-700 hover:underline">
                open decision →
              </a>
            )}
            {has("retry") && item.run_id && (
              <button
                type="button"
                onClick={() => setRetryOpen((o) => !o)}
                className="text-sm text-violet-700 hover:underline"
              >
                {retryOpen ? "close retry" : "↻ retry"}
              </button>
            )}
            {has("steering_note") && item.agent_slug && (
              <button
                type="button"
                onClick={() => setNoteOpen((o) => !o)}
                className="text-sm text-slate-600 hover:text-slate-900 hover:underline"
              >
                {noteOpen ? "close note" : "✎ steer"}
              </button>
            )}
            {has("engine_flip") && item.agent_slug && (
              <button
                type="button"
                onClick={() => onSetEngineProvider(item.agent_slug!, "openai")}
                disabled={busy === `${item.agent_slug}:engine`}
                className="text-sm text-blue-700 hover:underline disabled:opacity-40"
              >
                {busy === `${item.agent_slug}:engine` ? "…" : "→ OpenAI"}
              </button>
            )}
            {has("resolve_task") && item.task_id && (
              <button
                type="button"
                onClick={() => onResolveTask(item.task_id!)}
                disabled={busy === `task:${item.task_id}`}
                className="text-sm text-emerald-700 hover:underline disabled:opacity-40"
              >
                {busy === `task:${item.task_id}` ? "…" : "✓ resolve"}
              </button>
            )}
          </div>
          {noteOpen && item.agent_slug && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <NoteInline tenantId={tenantId} slug={item.agent_slug} onDone={() => setNoteOpen(false)} />
            </div>
          )}
          {retryOpen && item.run_id && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <RetryInline runId={item.run_id} onDone={() => setRetryOpen(false)} />
            </div>
          )}
          {editOpen && item.decision_id && (
            <div className="mt-2 border-t border-slate-100 pt-2 space-y-2">
              <div className="text-sm text-slate-500">
                Edit the proposed action&apos;s body, then approve. Re-validated server-side before it
                runs — a malformed edit is rejected, never executed.
              </div>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={8}
                spellCheck={false}
                className="w-full border rounded px-2 py-1 text-sm font-mono"
              />
              {editErr && <div className="text-sm text-rose-600">{editErr}</div>}
              <div className="text-right">
                <button
                  type="button"
                  disabled={decBusy}
                  onClick={() => {
                    let parsed: Record<string, unknown>;
                    try {
                      parsed = JSON.parse(editText) as Record<string, unknown>;
                    } catch {
                      setEditErr("Body must be valid JSON.");
                      return;
                    }
                    setEditErr(null);
                    onDecide(item.decision_id!, "approve", parsed);
                  }}
                  className="rounded-md bg-violet-700 text-white px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {decBusy ? "…" : "Approve with edits"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RetryInline({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function go() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await adminApiFetch(`/api/admin/runs/${runId}/retry`, {
        method: "POST",
        body: JSON.stringify(hint.trim() ? { hint: hint.trim() } : {}),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setOk(b.run_id ? `Retry run → ${String(b.run_id).slice(0, 8)}…` : "Retrying…");
      setTimeout(onDone, 1200);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-500">
        Re-fire this run. Optional hint is injected as a steering note the retry reads.
      </div>
      <textarea
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        placeholder="optional hint — e.g. the funnel tool was down; try again and skip the paid lever."
        rows={2}
        maxLength={2000}
        className="w-full border rounded px-2 py-1 text-sm"
      />
      {err && <div className="text-sm text-rose-600">{err}</div>}
      {ok && <div className="text-sm text-emerald-700">{ok}</div>}
      <div className="text-right">
        <button
          type="button"
          onClick={() => void go()}
          disabled={busy}
          className="rounded-md bg-violet-700 text-white px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy ? "Retrying…" : hint.trim() ? "Retry with hint" : "Retry"}
        </button>
      </div>
    </div>
  );
}

type CompanyFact = {
  key: string;
  value_text: string;
  source: string;
  source_ref: string | null;
  verified_at: string;
};

const FACT_LABEL: Record<string, string> = {
  domain: "Website",
  what_we_sell: "What they sell",
  who_we_serve: "Who they serve",
  competitors: "Who they compete with",
};

const FACT_HINT: Record<string, string> = {
  domain: "upcar.ai — agents use this in public CTAs. Wrong value = wrong domain in an ad.",
  what_we_sell: "One line, e.g. 'P2P car rental marketplace'",
  who_we_serve: "One line, e.g. 'car owners who want to earn, and renters'",
  competitors: "Names only, comma separated. Agents never quote a competitor's prices.",
};

const FACT_ORDER = ["domain", "what_we_sell", "who_we_serve", "competitors"];

type FactCitation = { name: string; url: string; source_title: string; source_url: string };

type Suggestion = {
  key: string;
  value: string;
  source: "brain" | "web" | "research";
  evidence: string;
  citations?: FactCitation[];
};

function CompanyFactsCard({
  tenantId,
  onFactsSaved,
}: {
  tenantId: string;
  onFactsSaved?: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, CompanyFact>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [researching, setResearching] = useState(false);
  const [suggested, setSuggested] = useState<Record<string, Suggestion>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-facts`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      const byKey: Record<string, CompanyFact> = {};
      for (const f of (b.facts ?? []) as CompanyFact[]) byKey[f.key] = f;
      setMeta(byKey);
      setVals(Object.fromEntries(FACT_ORDER.map((k) => [k, byKey[k]?.value_text ?? ""])));
      setSuggested({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function research() {
    setResearching(true);
    setErr(null);
    setSaved(false);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-facts/suggest`, {
        method: "POST",
        body: JSON.stringify({ domain_hint: vals.domain || undefined }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);

      const next: Record<string, Suggestion> = {};
      for (const s of (b.suggestions ?? []) as Suggestion[]) {
        if ((vals[s.key] ?? "").trim()) continue;
        next[s.key] = s;
      }
      setSuggested(next);
      setVals((v) => ({
        ...v,
        ...Object.fromEntries(Object.entries(next).map(([k, s]) => [k, s.value])),
      }));
      if (Object.keys(next).length === 0) setErr("Nothing new to suggest for the empty fields.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResearching(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const facts = FACT_ORDER.filter((k) => (vals[k] ?? "") !== (meta[k]?.value_text ?? "")).map(
        (k) => ({ key: k, value: vals[k] ?? "" }),
      );
      if (facts.length === 0) {
        setSaved(true);
        return;
      }
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-facts`, {
        method: "POST",
        body: JSON.stringify({ facts }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setSaved(true);
      await load();
      if (facts.some((f) => f.key === "domain")) onFactsSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = FACT_ORDER.some((k) => (vals[k] ?? "") !== (meta[k]?.value_text ?? ""));

  return (
    <div className="glass-card p-4">
      <div className="mb-1 text-xs uppercase tracking-[0.14em] text-slate-400">Company facts</div>
      <p className="mb-3 text-xs text-slate-500">
        Injected into <strong>every agent&apos;s prompt</strong> for this tenant. Blank = the agent
        doesn&apos;t know it and will ask, which is correct. Never guess a value here — a wrong
        website can end up in a public ad.
      </p>

      {loading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : (
        <div className="space-y-3">
          {FACT_ORDER.map((k) => {
            const f = meta[k];
            const ageDays = f
              ? Math.floor((Date.now() - Date.parse(f.verified_at)) / 86_400_000)
              : null;
            const stale = ageDays !== null && ageDays > 45;
            return (
              <div key={k}>
                <label className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-slate-600">{FACT_LABEL[k]}</span>
                  {f ? (
                    <span className={`text-[11px] ${stale ? "text-amber-600" : "text-slate-400"}`}>
                      {f.source === "human_confirmed" ? "confirmed" : f.source.replace(/_/g, " ")}
                      {ageDays !== null ? ` · ${ageDays}d ago` : ""}
                      {stale ? " · stale" : ""}
                    </span>
                  ) : suggested[k] ? (
                    <span className="text-[11px] text-blue-600">suggested — review before saving</span>
                  ) : (
                    <span className="text-[11px] text-slate-400">not set</span>
                  )}
                </label>
                <input
                  type="text"
                  value={vals[k] ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setVals((v) => ({ ...v, [k]: val }));
                    setSuggested((s) => {
                      if (!s[k]) return s;
                      const { [k]: _drop, ...rest } = s;
                      return rest;
                    });
                  }}
                  placeholder={FACT_HINT[k]}
                  className={`mt-1 w-full rounded border px-2 py-1.5 text-sm placeholder:text-slate-300 focus:outline-none ${
                    suggested[k]
                      ? "border-blue-300 bg-blue-50/50 text-slate-800 focus:border-blue-400"
                      : "border-slate-200 text-slate-800 focus:border-blue-400"
                  }`}
                />
                {suggested[k] ? (
                  <div className="mt-1 text-[11px] text-blue-600">{suggested[k].evidence}</div>
                ) : null}
                {suggested[k]?.citations?.length ? (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                    {suggested[k].citations!.map((c) => (
                      <li key={`${c.name}-${c.source_url}`} className="truncate">
                        <span className="text-slate-600">{c.name}</span>
                        {" — "}
                        <a
                          href={c.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 underline decoration-dotted hover:text-blue-700"
                          title={c.source_title || c.source_url}
                        >
                          {c.source_title || c.source_url}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save facts"}
            </button>
            <button
              type="button"
              onClick={() => void research()}
              disabled={researching || busy}
              title="Fill the blank fields from this tenant's own company brain (and the web for the website). Nothing is saved until you press Save."
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
            >
              {researching ? "Researching…" : "Research"}
            </button>
            {saved && !dirty ? <span className="text-xs text-emerald-600">Saved</span> : null}
            {err ? <span className="text-xs text-red-600">{err}</span> : null}
          </div>
          {Object.keys(suggested).length > 0 ? (
            <p className="text-[11px] text-blue-600">
              Highlighted fields are <strong>suggestions</strong>, not facts. Edit anything that&apos;s
              wrong, then Save — saving is what marks them confirmed by you.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
