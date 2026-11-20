"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, AlertTriangle, CheckSquare, ChevronDown, Loader2, Table2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { EmptyState, SectionTitle, Pill } from "./dashboard-ui";

type CanonicalMapEntry = { table?: string } & Record<string, string | undefined>;
export type CanonicalMap = Record<string, CanonicalMapEntry>;

type FieldProbe = {
  role: string;
  field_key: string;
  field: string;
  kind: string;
  ok: boolean;
  coverage?: number;
  reason?: string;
};

type ConstraintRow = {
  constraint: string;
  rank: number;
  rate: number | null;
  bucket_volume: number | null;
  evidence: {
    numerator: number | null;
    denominator: number | null;
    source: string | null;
    query_id: string | null;
  };
  elasticity_hint: string | null;
  build_cost_hint: string | null;
};

type Abstained = { constraint: string; reason: string };
type Schema = { tables: Array<{ name: string; columns: string[] }> };

export type DiagResponse =
  | { status: "disabled" }
  | { status: "not_available"; reason?: string; message?: string }
  | { status: "error"; message?: string }
  | {
      status: "requires_mapping_confirmation";
      catalog_hash: string | null;
      proposed_map: CanonicalMap;
      probes: FieldProbe[];
      looks_wrong?: boolean;
      probes_available?: boolean;
      cancel_leak_mappable?: boolean;
      message?: string;
      schema: Schema | null;
      tenant_id: string;
    }
  | {
      status: "diagnosed";
      catalog_hash: string | null;
      confirmed_at?: string;
      window_days?: number;
      probes: FieldProbe[];
      constraints: ConstraintRow[];
      abstained: Abstained[];
      note?: string;
      tenant_id: string;
    };

function humanize(s: string): string {
  return s
    .replace(/_field$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
function pctOf(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(1)}%`;
}
function numFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return n.toLocaleString();
}

const CARD = "rounded-3xl border border-[#f0f0f0] bg-white px-4 py-4";

const FIELD_KEY_ORDER = [
  "field",
  "id_field",
  "created_at_field",
  "listing_ref_field",
  "status_field",
  "reason_field",
  "geo_field",
  "category_field",
  "gmv_proxy_field",
] as const;

function fieldKeysOf(entry: CanonicalMapEntry): string[] {
  const present = Object.keys(entry).filter((k) => k !== "table" && entry[k]);
  const ordered = FIELD_KEY_ORDER.filter((k) => present.includes(k));
  const extras = present.filter((k) => !FIELD_KEY_ORDER.includes(k as never));
  return [...ordered, ...extras];
}

export function ConfirmMappingForm({
  data,
  onConfirmed,
  roles,
  onSave,
  intro,
  submitLabel,
  roleLabels,
  fieldLabels,
}: {
  data: Extract<DiagResponse, { status: "requires_mapping_confirmation" }>;
  onConfirmed: () => void;
  roles?: Record<string, readonly string[]>;
  onSave?: (clean: CanonicalMap) => Promise<string | null>;
  intro?: string;
  submitLabel?: string;
  roleLabels?: Record<string, string>;
  fieldLabels?: Record<string, string>;
}) {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [draft, setDraft] = useState<CanonicalMap>(() => {
    const copy: CanonicalMap = JSON.parse(JSON.stringify(data.proposed_map ?? {}));
    if (!roles) return copy;
    const scoped: CanonicalMap = {};
    for (const role of Object.keys(roles)) scoped[role] = copy[role] ?? { table: "" };
    return scoped;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const roleKey = Object.keys(roles ?? {}).sort().join(",");
  useEffect(() => {
    if (!roles) return;
    setDraft((current) => {
      const missing = Object.keys(roles).filter((role) => !current[role]);
      if (missing.length === 0) return current;
      const next: CanonicalMap = { ...current };
      for (const role of missing) {
        const proposed = (data.proposed_map ?? {})[role];
        next[role] = proposed ? (JSON.parse(JSON.stringify(proposed)) as CanonicalMap[string]) : { table: "" };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleKey]);

  const schemaTables = data.schema?.tables ?? [];
  const columnsFor = (table: string | undefined): string[] =>
    schemaTables.find((t) => t.name === table)?.columns ?? [];
  const hasSchema = schemaTables.length > 0;

  const setTable = (role: string, table: string) => {
    setDraft((d) => ({ ...d, [role]: { ...d[role], table } }));
  };
  const setField = (role: string, key: string, value: string) => {
    setDraft((d) => ({
      ...d,
      [role]: { ...d[role], [key]: value || undefined },
    }));
  };

  const confirm = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const clean: CanonicalMap = {};
      for (const [role, entry] of Object.entries(draft)) {
        if (!entry?.table) continue;
        const e: CanonicalMapEntry = { table: entry.table };
        for (const k of Object.keys(entry)) {
          if (k !== "table" && entry[k]) e[k] = entry[k];
        }
        clean[role] = e;
      }
      if (onSave) {
        const message = await onSave(clean);
        if (message) {
          setErr(message);
          return;
        }
        onConfirmed();
        return;
      }
      const { error } = await supabase.rpc("set_mapping_confirmed", {
        p_tenant_id: data.tenant_id,
        p_catalog_hash: data.catalog_hash,
        p_confirmed_map: clean,
      });
      if (error) {
        setErr(error.message || "Could not save the mapping. Check the fields and try again.");
        return;
      }
      onConfirmed();
    } catch {
      setErr("Could not save the mapping. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }, [draft, supabase, data.tenant_id, data.catalog_hash, onConfirmed, onSave]);

  const failing = (data.probes ?? []).filter((p) => !p.ok);

  return (
    <div className="rounded-2xl border border-rule bg-cream px-4 py-4">
      <p className="text-[16px] leading-5 text-inkMuted">
        {intro ??
          data.message ??
          "Confirm or correct how your database maps to the growth metrics, then run the diagnosis."}
      </p>

      {}
      {data.looks_wrong && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2.5 text-[13px] leading-5 text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            One or more mapped fields look wrong (see below). Correct them before
            you confirm, or the diagnosis would compute a false zero.
          </span>
        </div>
      )}
      {data.probes_available === false && (
        <div className="mt-3 rounded-xl bg-amber-500/15 px-3 py-2.5 text-[13px] leading-5 text-amber-600">
          Your data could not be sampled to sanity-check this mapping. Review it
          carefully before confirming.
        </div>
      )}
      {data.cancel_leak_mappable === false && (
        <div className="mt-2 text-[13px] text-inkMuted">
          No cancellation reason field is mapped, so the cancellation-leak lever
          will be skipped. Add one below if your data has it.
        </div>
      )}

      {failing.length > 0 && (
        <div className="mt-3 rounded-xl border border-rule bg-creamDeep px-3 py-2.5">
          <div className="mb-1 text-[13px] font-semibold text-ink">Fields that look wrong</div>
          <ul className="flex flex-col gap-1 text-[13px] leading-5 text-inkMuted">
            {failing.map((p, i) => (
              <li key={`${p.role}-${p.field_key}-${i}`} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden="true" />
                <span>
                  <span className="font-medium text-ink">
                    {humanize(p.role)} · {p.field}
                  </span>{" "}
                  ({p.kind}): {p.reason ?? "failed the sanity check"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {}
      <div className="mt-4 flex flex-col gap-3">
        {Object.entries(draft)
          .filter(([role]) => !roles || role in roles)
          .map(([role, entry]) => {
          const cols = columnsFor(entry.table);
          return (
            <div key={role} className="rounded-xl border border-rule bg-creamDeep/50 px-4 pb-4 pt-3.5">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bone text-inkSoft">
                  <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="text-[14px] font-semibold text-ink">
                  {roleLabels?.[role] ?? humanize(role)}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2">
                <MapField label="Table">
                  {hasSchema ? (
                    <MapSelect value={entry.table ?? ""} onChange={(v) => setTable(role, v)} options={schemaTables.map((t) => t.name)} />
                  ) : (
                    <input className={FIELD_INPUT} value={entry.table ?? ""} onChange={(e) => setTable(role, e.target.value)} />
                  )}
                </MapField>
                {(roles?.[role] ?? fieldKeysOf(entry)).map((key) => (
                  <MapField key={key} label={fieldLabels?.[key] ?? humanize(key)}>
                    {hasSchema ? (
                      <MapSelect value={entry[key] ?? ""} onChange={(v) => setField(role, key, v)} options={cols} />
                    ) : (
                      <input className={FIELD_INPUT} value={entry[key] ?? ""} onChange={(e) => setField(role, key, e.target.value)} />
                    )}
                  </MapField>
                ))}
              </div>
            </div>
            );
          })}
      </div>

      {err && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2.5 text-[13px] leading-5 text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{err}</span>
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={confirm}
          disabled={saving}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream transition-colors hover:bg-inkSoft disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckSquare className="h-4 w-4" aria-hidden="true" />
          )}
          {saving ? "Confirming…" : submitLabel ?? "Confirm mapping and run diagnosis"}
        </button>
      </div>
    </div>
  );
}

const FIELD_INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-rule bg-cream px-3 text-[16px] text-ink transition-colors hover:border-inkMuted/40 focus:border-inkMuted focus:outline-none focus:ring-2 focus:ring-ink/10";

function MapField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="truncate text-[14px] font-medium text-inkMuted" title={label}>
        {label}
      </span>
      {children}
    </label>
  );
}

function MapSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <span className="relative block">
      <select
        className={`${FIELD_INPUT} cursor-pointer appearance-none truncate pr-9 [&>option]:text-ink ${value ? "" : "text-inkMuted"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not set</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted" aria-hidden="true" />
    </span>
  );
}

function sourceTone(source: string | null): "good" | "warn" | "neutral" {
  if (source === "measured" || source === "high") return "good";
  if (source === "synthetic_only" || source === "low") return "warn";
  return "neutral";
}

export function DiagnosedView({
  data,
}: {
  data: Extract<DiagResponse, { status: "diagnosed" }>;
}) {
  const constraints = data.constraints ?? [];
  const abstained = data.abstained ?? [];
  return (
    <div className="flex flex-col gap-3">
      {constraints.length === 0 ? (
        <div className={`${CARD} text-[13px] text-[#595959]`}>
          No lever cleared the rankable gate yet. See what was withheld and why
          below.
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-[#f0f0f0] bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#f0f0f0] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                <th className="px-3 py-2.5 font-medium">#</th>
                <th className="px-3 py-2.5 font-medium">Constraint</th>
                <th className="px-3 py-2.5 text-right font-medium">Rate</th>
                <th className="px-3 py-2.5 text-right font-medium">Volume</th>
                <th className="px-3 py-2.5 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {constraints.map((r) => (
                <tr key={r.constraint} className="border-b border-[#f0f0f0] align-top last:border-0">
                  <td className="px-3 py-2.5 tabular-nums text-[#8a8a8a]">{r.rank}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#0e0f11]">{humanize(r.constraint)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-[#8a8a8a]">
                      {r.elasticity_hint && <span>elasticity: {r.elasticity_hint}</span>}
                      {r.build_cost_hint && <span>build: {r.build_cost_hint}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[#595959]">{pctOf(r.rate)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[#595959]">{numFmt(r.bucket_volume)}</td>
                  <td className="px-3 py-2.5 text-[11px] text-[#595959]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">
                        {numFmt(r.evidence.numerator)} / {numFmt(r.evidence.denominator)}
                      </span>
                      {r.evidence.source && (
                        <Pill tone={sourceTone(r.evidence.source)}>{r.evidence.source}</Pill>
                      )}
                    </div>
                    {r.evidence.query_id && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-[#a8a8a8]">
                        {r.evidence.query_id}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {abstained.length > 0 && (
        <div className={CARD}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
            Withheld (not enough clean data)
          </div>
          <ul className="flex flex-col gap-1 text-[12px] text-[#595959]">
            {abstained.map((a, i) => (
              <li key={`${a.constraint}-${i}`} className="flex items-center justify-between gap-2">
                <span className="font-medium text-[#0e0f11]">{humanize(a.constraint)}</span>
                <span className="text-[11px] text-[#8a8a8a]">{humanize(a.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.note && <p className="text-[11px] text-[#8a8a8a]">{data.note}</p>}
    </div>
  );
}

export function ConstraintCard() {
  const [data, setData] = useState<DiagResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const reqSeq = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch(
        `/api/agents/growth-lead/constraint-diagnosis${refresh ? "?refresh=1" : ""}`,
      );
      const json = (await res.json()) as DiagResponse;
      if (seq !== reqSeq.current) return;
      if (!res.ok) {
        setError(true);
      } else {
        setData(json);
      }
    } catch {
      if (seq === reqSeq.current) setError(true);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (data?.status === "disabled") return null;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <SectionTitle>Binding constraint</SectionTitle>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="inline-flex items-center gap-1 text-[12px] text-[#8a8a8a] transition-colors hover:text-[#1f1f1f] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {loading && !data ? (
        <div className={`${CARD} flex items-center gap-2 text-[13px] text-[#8a8a8a]`}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Diagnosing your binding constraint…
        </div>
      ) : error ? (
        <div className={`${CARD} text-[13px] text-[#595959]`}>
          Could not run the diagnosis right now.{" "}
          <button
            type="button"
            onClick={() => void load(true)}
            className="cursor-pointer font-semibold text-[#0e0f11] underline"
          >
            Try again
          </button>
        </div>
      ) : data?.status === "not_available" ? (
        <EmptyState title="Connect your database to diagnose your constraint">
          {data.message ??
            "Once your database is connected and discovered, this card ranks the binding growth constraint from your real data. Until then, ask growth-lead in the chat."}
        </EmptyState>
      ) : data?.status === "requires_mapping_confirmation" ? (
        <ConfirmMappingForm
          key={data.catalog_hash ?? "no-hash"}
          data={data}
          onConfirmed={() => void load(true)}
        />
      ) : data?.status === "diagnosed" ? (
        <DiagnosedView data={data} />
      ) : null}
    </section>
  );
}
