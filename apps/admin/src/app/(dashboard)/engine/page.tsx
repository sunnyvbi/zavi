"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { TenantPicker } from "@/components/admin/TenantPicker";

type AgentRow = {
  slug: string;
  name: string;
  default_provider: string;
  default_model: string;
  override_provider: string | null;
  override_model: string | null;
  effective_provider: string;
  effective_model: string;
  source: "agent_default" | "tenant_override";
  note: string | null;
  updated_at: string | null;
};

type ModelOptions = Record<string, string[]>;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude Agent SDK (default)",
  openai: "OpenAI Agents",
  bedrock: "Bedrock (open weights)",
  fireworks: "Fireworks (open weights)",
  langchain: "LangChain Deep Agents (+ skills)",
};

export default function AdminEnginePage() {
  return <Body />;
}

function Body() {
  const [tenantId, setTenantId] = useState<string>("");
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOptions>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [draft, setDraft] = useState<Record<string, { provider: string; model: string }>>({});

  const loadAgents = useCallback(async (tid: string) => {
    setAgents(null);
    setError(null);
    setDraft({});
    try {
      const res = await adminApiFetch(`/api/admin/engine-override?tenant_id=${encodeURIComponent(tid)}`);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setAgents((r.agents ?? []) as AgentRow[]);
      setModelOptions((r.model_options ?? {}) as ModelOptions);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (tenantId) void loadAgents(tenantId);
    else setAgents(null);
  }, [tenantId, loadAgents]);

  function rowDraft(a: AgentRow): { provider: string; model: string } {
    return draft[a.slug] ?? { provider: a.effective_provider, model: a.effective_model };
  }

  function setRowProvider(a: AgentRow, provider: string) {
    const opts = modelOptions[provider] ?? [];
    const cur = rowDraft(a);
    const model = opts.includes(cur.model) ? cur.model : (opts[0] ?? cur.model);
    setDraft((d) => ({ ...d, [a.slug]: { provider, model } }));
  }

  function setRowModel(a: AgentRow, model: string) {
    const cur = rowDraft(a);
    setDraft((d) => ({ ...d, [a.slug]: { provider: cur.provider, model } }));
  }

  async function save(a: AgentRow) {
    const d = rowDraft(a);
    setBusy(a.slug);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/engine-override", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          agent_slug: a.slug,
          provider: d.provider,
          model: d.model,
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await loadAgents(tenantId);
    } catch (e) {
      setError(`${a.slug}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function clearOverride(a: AgentRow) {
    setBusy(a.slug);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/engine-override", {
        method: "DELETE",
        body: JSON.stringify({ tenant_id: tenantId, agent_slug: a.slug }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await loadAgents(tenantId);
    } catch (e) {
      setError(`${a.slug}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">Engine override</h1>
      <p className="text-sm text-gray-500 mb-4">
        Per-(tenant, agent) provider + model. An override flips ONE agent for ONE
        tenant (e.g. onto OpenAI) without changing the global agent definition.
        Clearing reverts to the agent default. Requires a metered OPENAI_API_KEY
        in prod for OpenAI to actually run.
      </p>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-gray-600">Tenant:</label>
        <TenantPicker value={tenantId} onChange={setTenantId} />
      </div>

      {error && (
        <div className="mb-3 text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
          {error}
        </div>
      )}

      {tenantId && agents === null && !error && (
        <div className="text-sm text-gray-400">Loading…</div>
      )}

      {agents && (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-3">Agent</th>
              <th className="py-2 pr-3">Effective</th>
              <th className="py-2 pr-3">Provider</th>
              <th className="py-2 pr-3">Model</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const d = rowDraft(a);
              const providers = Object.keys(modelOptions);
              const models = modelOptions[d.provider] ?? [];
              const overridden = a.source === "tenant_override";
              const dirty =
                d.provider !== a.effective_provider || d.model !== a.effective_model;
              return (
                <tr key={a.slug} className="border-b">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{a.slug}</div>
                    <div className="text-xs text-gray-400">{a.name}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        overridden
                          ? "inline-block px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800"
                          : "inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
                      }
                      title={a.note ?? ""}
                    >
                      {a.effective_provider} · {a.effective_model}
                      {overridden ? " (override)" : " (default)"}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      className="border rounded px-1.5 py-1 text-xs"
                      value={d.provider}
                      onChange={(e) => setRowProvider(a, e.target.value)}
                      disabled={busy === a.slug}
                    >
                      {providers.map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_LABELS[p] ?? p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      className="border rounded px-1.5 py-1 text-xs"
                      value={d.model}
                      onChange={(e) => setRowModel(a, e.target.value)}
                      disabled={busy === a.slug}
                    >
                      {!models.includes(d.model) && (
                        <option value={d.model}>{d.model}</option>
                      )}
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <button
                      className="px-2 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-40"
                      onClick={() => void save(a)}
                      disabled={busy === a.slug || !dirty}
                    >
                      {busy === a.slug ? "…" : "Save"}
                    </button>
                    {overridden && (
                      <button
                        className="ml-2 px-2 py-1 text-xs rounded border text-gray-600 disabled:opacity-40"
                        onClick={() => void clearOverride(a)}
                        disabled={busy === a.slug}
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
