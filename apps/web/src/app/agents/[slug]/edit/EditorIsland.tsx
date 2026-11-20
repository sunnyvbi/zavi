"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { Input, Textarea } from "@/components/Input";
import { NextChevron } from "@/components/ui/NextChevron";

type VersionRow = {
  version: number;
  status: "draft" | "active" | "retired";
  created_at: string;
};

type EditSchema = {
  allowed_models: string[];
  tool_universe: string[];
  editable_fields: string[];
  locked_fields: string[];
  response_contracts: string[];
  recall_policies: string[];
  cost_classes: string[];
};

type EditableMeta = {
  model: string;
  tools: string[];
  output_envelope?: string;
  cron: string;
  triggers: string[];
  response_contract: string;
  recall_policy: string;
  cost_class: string;
  tool_iter_cap?: number;
  manual_only: boolean;
  prose_fallback: boolean;
  memory_layer: boolean;
};

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function metaPraxis(fm: Record<string, unknown>): Record<string, unknown> {
  const m = (fm?.metadata as Record<string, unknown> | undefined) ?? {};
  return (m.praxis as Record<string, unknown> | undefined) ?? {};
}

function readMeta(full: Record<string, unknown>): EditableMeta {
  const fm = metaPraxis(full);
  return {
    model: typeof fm.model === "string" ? fm.model : "",
    tools: asStringArray(fm.tools),
    output_envelope: typeof fm.output_envelope === "string" ? fm.output_envelope : undefined,
    cron: typeof fm.cron === "string" ? fm.cron : "",
    triggers: asStringArray(fm.triggers),
    response_contract: typeof fm.response_contract === "string" ? fm.response_contract : "auto",
    recall_policy: typeof fm.recall_policy === "string" ? fm.recall_policy : "live_state_aware",
    cost_class: typeof fm.cost_class === "string" ? fm.cost_class : "standard",
    tool_iter_cap: typeof fm.tool_iter_cap === "number" ? fm.tool_iter_cap : undefined,
    manual_only: fm.manual_only !== false,
    prose_fallback: fm.prose_fallback === true,
    memory_layer: fm.memory_layer !== false,
  };
}

const LOCKED_LABELS: Record<string, string> = {
  decision_class: "Autonomy / decision class",
  side_effects: "Side-effecting (money path)",
  requires_sandbox: "Requires sandbox",
  runtime: "Execution runtime",
  kill_switch: "Kill switch",
  impact_classes: "Impact classes",
};

export function EditorIsland({
  slug,
  initialBody,
  initialFrontmatter,
  versions,
}: {
  slug: string;
  initialBody: string;
  initialFrontmatter: Record<string, unknown>;
  versions: VersionRow[];
}) {
  const [body, setBody] = useState(initialBody);
  const [meta, setMeta] = useState<EditableMeta>(() => readMeta(initialFrontmatter));
  const [schema, setSchema] = useState<EditSchema | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ version: number; status: string } | null>(null);
  const [showAssist, setShowAssist] = useState(false);
  const [useCase, setUseCase] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [assistDraft, setAssistDraft] = useState<string | null>(null);
  const [preAssistBody, setPreAssistBody] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/agents/${slug}/edit-schema`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j) setSchema(j as EditSchema);
      })
      .catch(() => {
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  function buildFrontmatter(): Record<string, unknown> {
    const out: Record<string, unknown> = JSON.parse(JSON.stringify(initialFrontmatter ?? {}));
    const baseMeta = (out.metadata as Record<string, unknown> | undefined) ?? {};
    const praxis: Record<string, unknown> = {
      ...((baseMeta.praxis as Record<string, unknown> | undefined) ?? {}),
    };
    praxis.model = meta.model;
    praxis.tools = meta.tools;
    if (meta.output_envelope !== undefined) praxis.output_envelope = meta.output_envelope;
    praxis.cron = meta.cron;
    praxis.triggers = meta.triggers;
    praxis.response_contract = meta.response_contract;
    praxis.recall_policy = meta.recall_policy;
    praxis.cost_class = meta.cost_class;
    if (meta.tool_iter_cap !== undefined) praxis.tool_iter_cap = meta.tool_iter_cap;
    praxis.manual_only = meta.manual_only;
    praxis.prose_fallback = meta.prose_fallback;
    praxis.memory_layer = meta.memory_layer;
    delete praxis.setup;
    out.metadata = { ...baseMeta, praxis };
    return out;
  }

  async function save(status: "draft" | "active") {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await apiFetch(`/api/agents/${slug}/save`, {
        method: "POST",
        body: JSON.stringify({
          body_markdown: body,
          frontmatter: buildFrontmatter(),
          status,
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setSaved({ version: r.version, status });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function aiAssist() {
    if (!useCase.trim()) return;
    setAssisting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/agents/${slug}/ai-assist`, {
        method: "POST",
        body: JSON.stringify({ current_body: body, use_case: useCase }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      const draft = typeof r.drafted_body === "string" ? r.drafted_body : "";
      if (!draft) throw new Error("AI returned an empty rewrite");
      if (draft.trim() === body.trim()) {
        setError("AI returned the same body, so there are no changes to review.");
      } else {
        setAssistDraft(draft);
      }
      setShowAssist(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAssisting(false);
    }
  }

  function acceptAssist() {
    if (assistDraft === null) return;
    setPreAssistBody(body);
    setBody(assistDraft);
    setAssistDraft(null);
    setUseCase("");
  }

  function discardAssist() {
    setAssistDraft(null);
  }

  function undoAssist() {
    if (preAssistBody === null) return;
    setBody(preAssistBody);
    setPreAssistBody(null);
  }

  function toggleTool(t: string) {
    setMeta((m) => ({
      ...m,
      tools: m.tools.includes(t) ? m.tools.filter((x) => x !== t) : [...m.tools, t].sort(),
    }));
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6">
      {}
      <div>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
            {error}
          </div>
        )}
        {saved && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[13px] text-emerald-800">
            Saved as v{saved.version} ({saved.status}). Live runs use the latest active version.
          </div>
        )}

        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setShowAssist((s) => !s)}
            className="inline-flex items-center gap-2 rounded-cta border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:border-slate-300 transition-colors"
          >
            ✨ AI-assist
          </button>
          <button
            onClick={() => save("draft")}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-cta border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:border-slate-300 transition-colors disabled:opacity-50"
          >
            {busy ? "…" : "Save draft"}
          </button>
          <button
            onClick={() => save("active")}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-cta border border-transparent bg-skyMuted text-white px-4 py-1.5 text-[13px] font-medium hover:bg-brickDark transition-colors shadow-sm disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save & activate"}
          </button>
        </div>

        {showAssist && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
              Describe how you'd tune this agent
            </label>
            <Textarea
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
              rows={3}
              placeholder="e.g. focus the digest on disputes >$200 and trip-host fraud signals; demote routine support."
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={aiAssist}
                disabled={assisting || !useCase.trim()}
                className="inline-flex items-center gap-2 rounded-cta bg-slate-900 text-white px-3 py-1.5 text-[12px] font-medium hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {assisting ? "Drafting…" : "Draft rewrite"}
              </button>
              <button
                onClick={() => {
                  setShowAssist(false);
                  setUseCase("");
                }}
                className="text-[12px] text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              You&apos;ll review the rewrite as a diff before it touches your prompt. Nothing is applied automatically.
            </p>
          </div>
        )}

        {assistDraft !== null && (
          <AssistReview
            original={body}
            proposed={assistDraft}
            onAccept={acceptAssist}
            onDiscard={discardAssist}
          />
        )}

        {preAssistBody !== null && assistDraft === null && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-[13px] text-indigo-900">
            <span>AI rewrite applied. You can still revert to your previous body.</span>
            <button
              onClick={undoAssist}
              className="shrink-0 rounded-cta border border-indigo-300 bg-white px-3 py-1.5 text-[12px] font-medium text-indigo-800 hover:border-indigo-400 transition-colors"
            >
              Undo rewrite
            </button>
          </div>
        )}

        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={24}
          className="font-mono text-[13px] leading-[1.6]"
          spellCheck={false}
        />
        <p className="mt-2 text-[11px] text-slate-500">
          Body is rendered into the agent's system prompt at runtime. Metadata (model, tools,
          envelope, schedule, contract) is edited in the panel below.
        </p>

        <MetadataPanel
          meta={meta}
          setMeta={setMeta}
          schema={schema}
          baseFrontmatter={initialFrontmatter}
          toggleTool={toggleTool}
        />
      </div>

      {}
      <aside>
        <div className="sticky top-20">
          <h3 className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">Versions</h3>
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm divide-y divide-slate-100">
            {versions.map((v) => (
              <div key={v.version} className="px-3 py-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-mono text-slate-700">v{v.version}</div>
                  <div className="text-[11px] text-slate-400">{v.created_at.slice(0, 10)}</div>
                </div>
                <span className={statusClass(v.status)}>{v.status}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-slate-500 leading-[1.5]">
            Versions are immutable. Saving creates a new row. Activating retires the previous active.{" "}
            <Link href={`/agents/${slug}`} className="text-skyMuted hover:underline">
              Run this agent <NextChevron />
            </Link>
          </p>
        </div>
      </aside>
    </div>
  );
}

function MetadataPanel({
  meta,
  setMeta,
  schema,
  baseFrontmatter,
  toggleTool,
}: {
  meta: EditableMeta;
  setMeta: React.Dispatch<React.SetStateAction<EditableMeta>>;
  schema: EditSchema | null;
  baseFrontmatter: Record<string, unknown>;
  toggleTool: (t: string) => void;
}) {
  const models = schema?.allowed_models ?? [meta.model].filter(Boolean);
  const tools = schema?.tool_universe ?? meta.tools;
  const contracts = schema?.response_contracts ?? ["auto", "digest", "terse"];
  const recalls = schema?.recall_policies ?? ["always", "live_state_aware"];
  const costs = schema?.cost_classes ?? ["cheap", "standard", "expensive"];

  const COUPLED = new Set([
    "pr_proposal",
    "product_pm_backlog",
    "research_report",
    "competitor_brief",
    "supply_demand_brief",
    "advice",
    "application_finalized",
    "coach",
  ]);
  const envelopeLocked = !!meta.output_envelope && COUPLED.has(meta.output_envelope);
  const basePraxis = metaPraxis(baseFrontmatter);

  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
        <h3 className="text-[12px] font-semibold text-slate-800">Agent metadata</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Reshape what this teammate can do. Money/safety fields are locked and server-enforced.
        </p>
      </div>

      <div className="p-4 space-y-5">
        {}
        <Field label="Model">
          <select
            value={meta.model}
            onChange={(e) => setMeta((m) => ({ ...m, model: e.target.value }))}
            className={selectCls}
          >
            {!models.includes(meta.model) && meta.model && (
              <option value={meta.model}>{meta.model}</option>
            )}
            {models.map((mdl) => (
              <option key={mdl} value={mdl}>
                {mdl}
              </option>
            ))}
          </select>
        </Field>

        {}
        <Field label={`Tools (${meta.tools.length})`}>
          <div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200 p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
            {tools.map((t) => (
              <label key={t} className="flex items-center gap-2 text-[12px] font-mono text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={meta.tools.includes(t)}
                  onChange={() => toggleTool(t)}
                />
                {t}
              </label>
            ))}
            {tools.length === 0 && <span className="text-[12px] text-slate-400">No tools available.</span>}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Connectors are re-derived from your tool selection on save.
          </p>
        </Field>

        {}
        <Field label="Output envelope">
          <Input
            value={meta.output_envelope ?? ""}
            disabled={envelopeLocked}
            onChange={(e) =>
              setMeta((m) => ({ ...m, output_envelope: e.target.value || undefined }))
            }
            placeholder="(none: plain prose)"
            className="font-mono text-[12px]"
          />
          {envelopeLocked && (
            <p className="text-[11px] text-amber-700 mt-1">
              This envelope drives a downstream pipeline, so it is locked.
            </p>
          )}
        </Field>

        {}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Schedule (cron)">
            <Input
              value={meta.cron}
              onChange={(e) => setMeta((m) => ({ ...m, cron: e.target.value }))}
              placeholder="0 9 * * *  (blank = manual)"
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label="Triggers (comma-sep)">
            <Input
              value={meta.triggers.join(", ")}
              onChange={(e) =>
                setMeta((m) => ({
                  ...m,
                  triggers: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="e.g. webhook, a2a"
              className="font-mono text-[12px]"
            />
          </Field>
        </div>

        {}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Response contract">
            <select
              value={meta.response_contract}
              onChange={(e) => setMeta((m) => ({ ...m, response_contract: e.target.value }))}
              className={selectCls}
            >
              {contracts.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Recall policy">
            <select
              value={meta.recall_policy}
              onChange={(e) => setMeta((m) => ({ ...m, recall_policy: e.target.value }))}
              className={selectCls}
            >
              {recalls.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cost class">
            <select
              value={meta.cost_class}
              onChange={(e) => setMeta((m) => ({ ...m, cost_class: e.target.value }))}
              className={selectCls}
            >
              {costs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Toggle
            label="Manual-only (no auto-fire)"
            checked={meta.manual_only}
            onChange={(v) => setMeta((m) => ({ ...m, manual_only: v }))}
          />
          <Toggle
            label="Memory layer"
            checked={meta.memory_layer}
            onChange={(v) => setMeta((m) => ({ ...m, memory_layer: v }))}
          />
          <Toggle
            label="Prose fallback"
            checked={meta.prose_fallback}
            onChange={(v) => setMeta((m) => ({ ...m, prose_fallback: v }))}
          />
        </div>

        {}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500 mb-2">
            Locked (staff-only · money / safety path)
          </div>
          <div className="space-y-1.5">
            {(schema?.locked_fields ?? Object.keys(LOCKED_LABELS)).map((k) => (
              <div key={k} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="text-slate-600">{LOCKED_LABELS[k] ?? k}</span>
                <code className="font-mono text-[11px] text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5">
                  {fmtLocked(basePraxis[k])}
                </code>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-2 leading-[1.5]">
            The approval gate is not bypassable here. Any change to these is rejected server-side
            even if posted directly.
          </p>
        </div>
      </div>
    </div>
  );
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

function lineDiff(original: string, proposed: string): DiffLine[] {
  const a = original.split("\n");
  const b = proposed.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

function AssistReview({
  original,
  proposed,
  onAccept,
  onDiscard,
}: {
  original: string;
  proposed: string;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const diff = lineDiff(original, proposed);
  const added = diff.filter((d) => d.kind === "add").length;
  const removed = diff.filter((d) => d.kind === "del").length;

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-indigo-100 bg-indigo-50 px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-indigo-900">✨ Review AI rewrite</h3>
          <p className="text-[11px] text-indigo-700/80 mt-0.5">
            <span className="text-emerald-700">+{added}</span>{" "}
            <span className="text-rose-700">−{removed}</span> lines. Nothing is applied until you accept.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onDiscard}
            className="rounded-cta border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-slate-300 transition-colors"
          >
            Discard
          </button>
          <button
            onClick={onAccept}
            className="rounded-cta border border-transparent bg-indigo-600 text-white px-3.5 py-1.5 text-[12px] font-medium hover:bg-indigo-700 transition-colors shadow-sm"
          >
            Accept rewrite
          </button>
        </div>
      </div>
      <pre className="max-h-[420px] overflow-auto p-3 text-[12px] leading-[1.55] bg-slate-50">
        {diff.map((d, idx) => {
          const cls =
            d.kind === "add"
              ? "text-emerald-800 bg-emerald-50"
              : d.kind === "del"
                ? "text-rose-800 bg-rose-50"
                : "text-slate-600";
          const marker = d.kind === "add" ? "+" : d.kind === "del" ? "−" : " ";
          return (
            <code key={idx} className={`block whitespace-pre-wrap font-mono ${cls}`}>
              {marker} {d.text || " "}
            </code>
          );
        })}
      </pre>
    </div>
  );
}

function fmtLocked(v: unknown): string {
  if (v === undefined || v === null) return "-";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "-";
  return String(v);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const selectCls =
  "w-full rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 text-[13px] focus:border-[#171717] focus:outline-none focus:ring-4 focus:ring-[#171717]/10";

function statusClass(s: VersionRow["status"]): string {
  const base = "text-[11px] font-mono uppercase tracking-[0.14em] rounded-full px-2 py-0.5";
  if (s === "active") return `${base} bg-emerald-100 text-emerald-800`;
  if (s === "draft") return `${base} bg-slate-100 text-slate-700`;
  return `${base} bg-slate-100 text-slate-500`;
}
