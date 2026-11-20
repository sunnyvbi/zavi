"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { TenantPicker } from "@/components/admin/TenantPicker";
import { EMPTY, carriedSummary, toConfig, toForm, type Config, type Form } from "./variant-form";

type Variant = { slug: string; label: string; config: Config; note: string | null; updated_at: string };
type Assignment = {
  tenant_id: string;
  agent_slug: string;
  variant_slug: string;
  tenants: { name: string | null; slug: string | null } | null;
};
type Listing = {
  variants: Variant[];
  assignments: Assignment[];
  agents: string[];
  droppable_core: string[];
  globals: Record<string, string>;
  kill_switch: boolean;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const input = "border rounded px-2 py-1 text-sm";

export default function EngineVariantsPage() {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [tenantId, setTenantId] = useState("");
  const [agent, setAgent] = useState("");
  const [variant, setVariant] = useState("");
  const [gAgent, setGAgent] = useState("*");
  const [gVariant, setGVariant] = useState("");

  const load = useCallback(async () => {
    const res = await adminApiFetch("/api/admin/engine-variants");
    if (!res.ok) return setError(`Could not load variants (${res.status})`);
    setData((await res.json()) as Listing);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async (path: string, method: string, body?: unknown) => {
    setError(null);
    const res = await adminApiFetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; expected?: string; issues?: unknown };
      setError(
        j.error === "prompt_file_missing"
          ? `That variant needs the prompt file ${j.expected}, which is not deployed for this agent.`
          : `${j.error ?? res.status}${j.issues ? ` — ${JSON.stringify(j.issues)}` : ""}`,
      );
      return false;
    }
    await load();
    return true;
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">Engine variants</h1>
      <p className="text-sm text-gray-500 mb-4">
        Default is today&apos;s prompts and settings. A variant lists only what it changes, and applies
        only to the tenant + agent pairs you assign it to.
      </p>

      {error && (
        <div className="mb-3 text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">{error}</div>
      )}
      {!data ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          <table className="w-full text-sm border-collapse mb-6">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-3">Variant</th>
                <th className="py-2 pr-3">Changes from default</th>
                <th className="py-2 pr-3">In use</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr className="border-b text-gray-500">
                <td className="py-2 pr-3 font-medium">default</td>
                <td className="py-2 pr-3">Nothing — current prompts and settings</td>
                <td className="py-2 pr-3">everything not assigned below</td>
                <td />
              </tr>
              {data.variants.map((v) => (
                <tr key={v.slug} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{v.slug}</div>
                    <div className="text-gray-500">{v.label}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <code className="text-xs break-all">{JSON.stringify(v.config)}</code>
                  </td>
                  <td className="py-2 pr-3">
                    {data.assignments.filter((a) => a.variant_slug === v.slug).length} pair(s)
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    <button className="text-blue-600 mr-3" onClick={() => setForm(toForm(v))}>
                      Edit
                    </button>
                    <button
                      className="text-red-600"
                      onClick={() => {
                        if (confirm(`Delete ${v.slug}? Every pair using it returns to default.`))
                          void send(`/api/admin/engine-variants?slug=${encodeURIComponent(v.slug)}`, "DELETE");
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="font-semibold mb-2">{data.variants.some((v) => v.slug === form.slug) ? "Edit" : "New"} variant</h2>
          <form
            className="grid grid-cols-2 gap-3 mb-8 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void send("/api/admin/engine-variants", "POST", {
                slug: form.slug,
                label: form.label,
                config: toConfig(form),
                ...(form.note.trim() ? { note: form.note.trim() } : {}),
              }).then((ok) => ok && setForm(EMPTY));
            }}
          >
            <label>
              Slug
              <input className={`${input} w-full`} required pattern="[a-z0-9][a-z0-9_-]{0,39}" value={form.slug} onChange={(e) => set("slug", e.target.value)} placeholder="v1-lean" />
            </label>
            <label>
              Label
              <input className={`${input} w-full`} required maxLength={80} value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="Lean prompt + low effort" />
            </label>
            <label>
              Model (blank = agent&apos;s own)
              <input className={`${input} w-full`} value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="claude-haiku-4-5-20251001" />
            </label>
            <label>
              Effort
              <select className={`${input} w-full`} value={form.effort} onChange={(e) => set("effort", e.target.value)}>
                <option value="">default</option>
                {EFFORTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Thinking
              <select className={`${input} w-full`} value={form.thinking} onChange={(e) => set("thinking", e.target.value)}>
                <option value="">default</option>
                <option value="disabled">disabled</option>
                <option value="adaptive">adaptive</option>
                <option value="enabled">enabled, with a token budget</option>
              </select>
            </label>
            <label>
              Thinking budget (tokens)
              <input className={`${input} w-full`} type="number" min={1024} max={32000} disabled={form.thinking !== "enabled"} value={form.budget} onChange={(e) => set("budget", e.target.value)} />
            </label>
            <label>
              Max turns (blank = agent&apos;s own)
              <input className={`${input} w-full`} type="number" min={10} max={120} value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} />
            </label>
            <label>
              Prompt file — agents/&lt;agent&gt;/agent.<b>name</b>.md
              <input className={`${input} w-full`} pattern="[a-z0-9_-]{1,24}" value={form.agentFile} onChange={(e) => set("agentFile", e.target.value)} placeholder="v1" />
            </label>
            <fieldset className="col-span-2">
              <legend>Leave out these style rules (security and grounding rules can never be removed)</legend>
              {data.droppable_core.map((c) => (
                <label key={c} className="inline-flex items-center mr-4">
                  <input
                    type="checkbox"
                    className="mr-1"
                    checked={form.dropCore.includes(c)}
                    onChange={(e) => set("dropCore", e.target.checked ? [...form.dropCore, c] : form.dropCore.filter((x) => x !== c))}
                  />
                  {c}
                </label>
              ))}
            </fieldset>
            <label className="col-span-2 inline-flex items-center">
              <input type="checkbox" className="mr-1" checked={form.isolate} onChange={(e) => set("isolate", e.target.checked)} />
              Don&apos;t load CLAUDE.md or settings files from disk
            </label>
            <label className="col-span-2">
              Note
              <input className={`${input} w-full`} maxLength={500} value={form.note} onChange={(e) => set("note", e.target.value)} />
            </label>
            {carriedSummary(form) && (
              <p className="col-span-2 text-xs text-gray-500">
                Kept as-is (no field here, saved unchanged): <code>{carriedSummary(form)}</code>
              </p>
            )}
            <div className="col-span-2">
              <button type="submit" className="bg-black text-white rounded px-3 py-1 mr-2">Save variant</button>
              <button type="button" className="text-gray-600" onClick={() => setForm(EMPTY)}>Clear</button>
            </div>
          </form>

          <h2 className="font-semibold mb-2">Global default</h2>
          <p className="text-sm text-gray-500 mb-2">
            Applies to every tenant that has no specific assignment below. Takes effect on the next
            run — no deploy. A per-agent entry beats <code>*</code>; an assignment below beats both.
          </p>
          {data.kill_switch && (
            <div className="mb-2 text-sm text-amber-700 border border-amber-200 bg-amber-50 rounded px-3 py-2">
              The fleet kill switch (<code>engine_variants_disabled</code>) is ON, so every run is on
              default right now and nothing on this page is applying.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
            <select className={input} value={gAgent} onChange={(e) => setGAgent(e.target.value)}>
              <option value="*">every agent (*)</option>
              {data.agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select className={input} value={gVariant} onChange={(e) => setGVariant(e.target.value)}>
              <option value="">default (clear)</option>
              {data.variants.map((v) => (
                <option key={v.slug}>{v.slug}</option>
              ))}
            </select>
            <button
              className="bg-black text-white rounded px-3 py-1"
              onClick={() =>
                void send("/api/admin/engine-variants/global", "POST", {
                  agent_slug: gAgent,
                  variant_slug: gVariant || null,
                })
              }
            >
              Apply globally
            </button>
          </div>
          <table className="w-full text-sm border-collapse mb-6">
            <tbody>
              {Object.keys(data.globals).length === 0 && (
                <tr>
                  <td className="py-2 text-gray-400">No global default — every unassigned run is on default.</td>
                </tr>
              )}
              {Object.entries(data.globals).map(([a, slug]) => (
                <tr key={a} className="border-b">
                  <td className="py-2 pr-3">{a === "*" ? "every agent (*)" : a}</td>
                  <td className="py-2 pr-3 font-medium">{slug}</td>
                  <td className="py-2 text-right">
                    <button
                      className="text-blue-600"
                      onClick={() =>
                        void send("/api/admin/engine-variants/global", "POST", {
                          agent_slug: a,
                          variant_slug: null,
                        })
                      }
                    >
                      Back to default
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="font-semibold mb-2">Assign to a tenant + agent</h2>
          <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
            <TenantPicker value={tenantId} onChange={setTenantId} />
            <select className={input} value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">agent…</option>
              {data.agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select className={input} value={variant} onChange={(e) => setVariant(e.target.value)}>
              <option value="">default</option>
              {data.variants.map((v) => (
                <option key={v.slug}>{v.slug}</option>
              ))}
            </select>
            <button
              className="bg-black text-white rounded px-3 py-1 disabled:opacity-40"
              disabled={!tenantId || !agent}
              onClick={() =>
                void send("/api/admin/engine-variants/assign", "POST", {
                  tenant_id: tenantId,
                  agent_slug: agent,
                  variant_slug: variant || null,
                })
              }
            >
              Apply
            </button>
          </div>
          <table className="w-full text-sm border-collapse">
            <tbody>
              {data.assignments.length === 0 && (
                <tr>
                  <td className="py-2 text-gray-400">No assignments — every run is on default.</td>
                </tr>
              )}
              {data.assignments.map((a) => (
                <tr key={`${a.tenant_id}/${a.agent_slug}`} className="border-b">
                  <td className="py-2 pr-3">{a.tenants?.name ?? a.tenants?.slug ?? a.tenant_id}</td>
                  <td className="py-2 pr-3">{a.agent_slug}</td>
                  <td className="py-2 pr-3 font-medium">{a.variant_slug}</td>
                  <td className="py-2 text-right">
                    <button
                      className="text-blue-600"
                      onClick={() =>
                        void send("/api/admin/engine-variants/assign", "POST", {
                          tenant_id: a.tenant_id,
                          agent_slug: a.agent_slug,
                          variant_slug: null,
                        })
                      }
                    >
                      Back to default
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
