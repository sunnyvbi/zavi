"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type AgentRow = {
  tenant_id: string;
  slug: string;
  version: number;
  status: string;
  parent_template: string | null;
  created_at: string;
};

type VisibilityRow = {
  slug: string;
  name: string;
  description: string;
  hidden: boolean;
  default_state?: "enabled" | "disabled" | "always_on";
  is_locked?: boolean;
};

type VisibilityResp = {
  slugs: VisibilityRow[];
  updated_at: string | null;
  updated_by: string | null;
};

export default function AdminAgentsPage() {
  return <Body />;
}

function Body() {
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/agents?limit=1000`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRows((r.agents ?? []) as AgentRow[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!rows) return null;
    const map = new Map<
      string,
      Array<{ tenant_id: string; version: number; parent_template: string | null }>
    >();
    for (const r of rows) {
      const arr = map.get(r.slug) ?? [];
      arr.push({
        tenant_id: r.tenant_id,
        version: r.version,
        parent_template: r.parent_template,
      });
      map.set(r.slug, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin
        </div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Agents</h1>
        <p className="text-sm text-slate-500 mt-1">
          One row per (tenant, slug) at the active version. Drift = same slug, different version
          across tenants.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      <VisibilityPanel />
      <TenantVisibilityPanel />

      {grouped === null ? (
        <div className="text-sm text-slate-500">Loading agents…</div>
      ) : grouped.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No agents yet.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([slug, fleet]) => {
            const versions = new Set(fleet.map((f) => f.version));
            const drift = versions.size > 1;
            return (
              <div key={slug} className="glass-card">
                <div className="flex items-baseline justify-between px-4 py-2.5 border-b border-slate-100">
                  <div className="text-sm text-slate-900">{slug}</div>
                  <div className="text-sm text-slate-500">
                    {drift ? (
                      <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5">
                        drift: {versions.size} versions
                      </span>
                    ) : (
                      <span>v{fleet[0].version} across {fleet.length} tenants</span>
                    )}
                  </div>
                </div>
                <ul className="divide-y divide-slate-100">
                  {fleet.map((f) => (
                    <li
                      key={f.tenant_id}
                      className="px-4 py-2 flex items-center gap-4 text-sm"
                    >
                      <Link
                        href={`/tenants/${f.tenant_id}`}
                        className="font-mono text-slate-700 hover:underline w-44"
                      >
                        {f.tenant_id.slice(0, 8)}
                      </Link>
                      <span className="font-mono text-slate-600 w-20">v{f.version}</span>
                      <span className="text-slate-500 truncate">
                        {f.parent_template ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VisibilityPanel() {
  const [data, setData] = useState<VisibilityResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenLocal, setHiddenLocal] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/agent-visibility");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      const resp = r as VisibilityResp;
      setData(resp);
      setHiddenLocal(new Set(resp.slugs.filter((s) => s.hidden).map((s) => s.slug)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const serverHidden = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.slugs.filter((s) => s.hidden).map((s) => s.slug));
  }, [data]);

  const dirty = useMemo(() => {
    if (hiddenLocal.size !== serverHidden.size) return true;
    for (const s of hiddenLocal) if (!serverHidden.has(s)) return true;
    return false;
  }, [hiddenLocal, serverHidden]);

  function toggle(slug: string) {
    const next = new Set(hiddenLocal);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setHiddenLocal(next);
  }

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/agent-visibility", {
        method: "POST",
        body: JSON.stringify({
          disabled_agent_slugs: Array.from(hiddenLocal).sort(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass-card mb-6">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-slate-100">
        <div>
          <div className="font-display font-semibold text-base text-slate-900">
            Global visibility
          </div>
          <div className="text-sm text-slate-500 mt-0.5">
            Hidden agents drop from every workspace sidebar / CmdK / restored tabs.
            Direct dispatch + scheduled runs unaffected.
          </div>
        </div>
        <div className="text-xs text-slate-400">
          {data?.updated_at
            ? `updated ${new Date(data.updated_at).toLocaleString()}`
            : "never updated"}
          {data?.updated_by && (
            <>
              {" · "}by{" "}
              <span className="text-slate-600">{data.updated_by.slice(0, 8)}</span>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="m-3 rounded-md border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800">
          {error}
        </div>
      )}

      {!data ? (
        <div className="p-6 text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
            {data.slugs.map((s) => {
              const hidden = hiddenLocal.has(s.slug);
              const locked = s.is_locked === true;
              const defaultState = s.default_state ?? "enabled";
              return (
                <li
                  key={s.slug}
                  className="px-4 py-2.5 flex items-start gap-3"
                >
                  <button
                    type="button"
                    onClick={() => !locked && toggle(s.slug)}
                    aria-pressed={!hidden}
                    aria-disabled={locked}
                    disabled={locked}
                    title={locked ? "Locked by Zavi (always_on agent)" : undefined}
                    className={
                      "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
                      (locked
                        ? "bg-emerald-500 opacity-50 cursor-not-allowed"
                        : hidden
                        ? "bg-slate-300"
                        : "bg-emerald-500")
                    }
                  >
                    <span
                      className={
                        "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " +
                        (hidden && !locked ? "translate-x-0.5" : "translate-x-[18px]")
                      }
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm text-slate-900">
                        {s.slug}
                      </span>
                      <span className="text-sm text-slate-500">{s.name}</span>
                      {}
                      {defaultState === "always_on" ? (
                        <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs">
                          🔒 always-on
                        </span>
                      ) : defaultState === "disabled" ? (
                        <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 text-xs">
                          default-off
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-xs">
                          default-on
                        </span>
                      )}
                      {hidden && !locked && (
                        <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 text-xs">
                          hidden
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <div className="text-sm text-slate-500 mt-0.5 line-clamp-2">
                        {s.description}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100">
            <div className="text-sm text-slate-500">
              {hiddenLocal.size} of {data.slugs.length} hidden
              {dirty && (
                <span className="ml-2 text-amber-700 font-medium">· unsaved</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setHiddenLocal(new Set(serverHidden))}
                disabled={!dirty || submitting}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-30"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!dirty || submitting}
                className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type TenantSlug = {
  slug: string;
  name: string;
  hidden_global: boolean;
  hidden_tenant: boolean;
  source: string | null;
  default_state?: "enabled" | "disabled" | "always_on";
  effective_state?: "visible" | "hidden";
  effective_reason?: string;
  override_state?: "hidden" | "visible" | null;
  is_locked?: boolean;
};

function TenantVisibilityPanel() {
  const [tenantId, setTenantId] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [slugs, setSlugs] = useState<TenantSlug[] | null>(null);
  const [wantHidden, setWantHidden] = useState<Set<string>>(new Set());
  const [wantVisible, setWantVisible] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    setNotice(null);
    setSlugs(null);
    try {
      const res = await adminApiFetch(
        `/api/admin/agent-visibility/tenant?tenant_id=${encodeURIComponent(tenantId.trim())}`,
      );
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      const rs = (r.slugs ?? []) as TenantSlug[];
      setSlugs(rs);
      setWantHidden(
        new Set(
          rs
            .filter(
              (s) => s.source === "staff" && (s.override_state ?? "hidden") === "hidden",
            )
            .map((s) => s.slug),
        ),
      );
      setWantVisible(
        new Set(
          rs
            .filter((s) => s.source === "staff" && s.override_state === "visible")
            .map((s) => s.slug),
        ),
      );
      setLoaded(tenantId.trim());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleHide(slug: string) {
    const h = new Set(wantHidden);
    if (h.has(slug)) h.delete(slug);
    else {
      h.add(slug);
      const v = new Set(wantVisible);
      v.delete(slug);
      setWantVisible(v);
    }
    setWantHidden(h);
  }

  function toggleShow(slug: string) {
    const v = new Set(wantVisible);
    if (v.has(slug)) v.delete(slug);
    else {
      v.add(slug);
      const h = new Set(wantHidden);
      h.delete(slug);
      setWantHidden(h);
    }
    setWantVisible(v);
  }

  async function save() {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApiFetch("/api/admin/agent-visibility/tenant", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: loaded,
          hidden_slugs: Array.from(wantHidden).sort(),
          visible_slugs: Array.from(wantVisible).sort(),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      const ig = (r.ignored_global ?? []) as string[];
      const lk = (r.ignored_locked ?? []) as string[];
      const msgs: string[] = [];
      if (ig.length > 0) msgs.push(`global-hidden: ${ig.join(", ")}`);
      if (lk.length > 0) msgs.push(`always-on locked: ${lk.join(", ")}`);
      setNotice(
        msgs.length > 0 ? `Saved. Skipped — ${msgs.join("; ")}` : "Saved.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-card mb-6">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="font-display font-semibold text-base text-slate-900">
          Per-tenant visibility
        </div>
        <div className="text-sm text-slate-500 mt-0.5">
          Force-hide agents for one tenant. Staff-hidden agents are locked —
          the tenant can’t un-hide them. Tenant self-hides are read-only here.
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="tenant_id (uuid)"
            className="flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
          />
          <button
            type="button"
            onClick={load}
            disabled={!tenantId.trim()}
            className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
          >
            Load
          </button>
        </div>
      </div>

      {error && (
        <div className="m-3 rounded-md border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="m-3 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {slugs && (
        <>
          <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
            {slugs.map((s) => {
              const tenantManaged = s.source === "tenant";
              const locked = s.is_locked === true;
              const defaultState = s.default_state ?? "enabled";
              const isHidden = wantHidden.has(s.slug);
              const isVisible = wantVisible.has(s.slug);
              const effective =
                s.effective_state ?? (s.hidden_global || s.hidden_tenant ? "hidden" : "visible");
              const readOnly = locked || tenantManaged;
              return (
                <li key={s.slug} className="px-4 py-2.5 flex items-start gap-3">
                  {}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => !readOnly && toggleHide(s.slug)}
                      aria-pressed={isHidden}
                      title={
                        locked
                          ? "Locked by Zavi (always_on)"
                          : tenantManaged
                          ? "Tenant self-hid this — read-only"
                          : "Force-hide this agent for this tenant"
                      }
                      className={
                        "rounded px-2 py-0.5 text-xs border transition-colors " +
                        (isHidden
                          ? "bg-rose-100 text-rose-800 border-rose-300"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-rose-50") +
                        (readOnly ? " opacity-40 cursor-not-allowed" : "")
                      }
                    >
                      hide
                    </button>
                    <button
                      type="button"
                      disabled={readOnly || defaultState === "always_on"}
                      onClick={() => !readOnly && toggleShow(s.slug)}
                      aria-pressed={isVisible}
                      title={
                        locked
                          ? "Already visible (always_on)"
                          : "Opt this tenant INTO this agent (overrides default-off + global hide)"
                      }
                      className={
                        "rounded px-2 py-0.5 text-xs border transition-colors " +
                        (isVisible
                          ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-emerald-50") +
                        (readOnly || defaultState === "always_on"
                          ? " opacity-40 cursor-not-allowed"
                          : "")
                      }
                    >
                      show
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm text-slate-900">
                        {s.slug}
                      </span>
                      <span className="text-sm text-slate-500">
                        {s.name}
                      </span>
                      {}
                      {defaultState === "always_on" ? (
                        <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs">
                          🔒 always-on
                        </span>
                      ) : defaultState === "disabled" ? (
                        <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 text-xs">
                          default-off
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-xs">
                          default-on
                        </span>
                      )}
                      {}
                      <span
                        className={
                          "rounded px-1.5 py-0.5 text-xs " +
                          (effective === "visible"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-rose-50 text-rose-700")
                        }
                      >
                        → {effective}
                      </span>
                      {s.hidden_global && (
                        <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 text-xs">
                          global-hide
                        </span>
                      )}
                      {tenantManaged && (
                        <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs">
                          tenant-managed
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100">
            <div className="text-sm text-slate-500">
              {wantHidden.size} hide · {wantVisible.size} show · always-on
              agents not toggleable
            </div>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save overrides"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
