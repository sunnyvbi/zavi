"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronDown, Search } from "lucide-react";
import { adminApiFetch } from "@/lib/api-admin";

export type TenantLite = {
  id: string;
  slug: string;
  display_name: string | null;
};

const MAX_RENDER = 50;

function label(t: TenantLite): string {
  return `${t.display_name || t.slug} (${t.slug})`;
}

export function TenantPicker({
  value,
  onChange,
  placeholder = "Search tenants by name, slug, or id…",
  variant = "input",
  disabled = false,
}: {
  value: string;
  onChange: (tenantId: string) => void;
  placeholder?: string;
  variant?: "input" | "pill";
  disabled?: boolean;
}) {
  const [tenants, setTenants] = useState<TenantLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/tenants");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        setTenants((r.tenants ?? []) as TenantLite[]);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selected = useMemo(
    () => (tenants ?? []).find((t) => t.id === value) ?? null,
    [tenants, value],
  );

  const matches = useMemo(() => {
    const all = tenants ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, MAX_RENDER);
    const hits = all.filter(
      (t) =>
        (t.display_name ?? "").toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q),
    );
    return hits;
  }, [tenants, query]);

  const shown = matches.slice(0, MAX_RENDER);
  const overflow = matches.length - shown.length;

  const rows =
    shown.length === 0 ? (
      <div className="px-2 py-2 text-gray-400">No matches</div>
    ) : (
      shown.map((t) => (
        <button
          type="button"
          key={t.id}
          className={
            "block w-full text-left px-2 py-1.5 hover:bg-gray-100 " +
            (t.id === value ? "bg-gray-50 font-medium" : "")
          }
          onClick={() => {
            onChange(t.id);
            setOpen(false);
            setQuery("");
          }}
        >
          <span>{t.display_name || t.slug}</span>{" "}
          <span className="text-xs text-gray-400">
            {t.slug} · {t.id.slice(0, 8)}
          </span>
        </button>
      ))
    );

  const overflowNote = overflow > 0 && (
    <div className="px-2 py-1.5 text-xs text-gray-400 border-t">
      +{overflow} more — keep typing to narrow
    </div>
  );

  if (variant === "pill") {
    return (
      <div className="relative" ref={boxRef}>
        <button
          type="button"
          disabled={disabled || tenants === null}
          onClick={() => {
            if (disabled) return;
            setOpen((o) => !o);
            setQuery("");
          }}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50"
        >
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="max-w-40 truncate">
            {tenants === null ? "Loading clients…" : selected ? selected.display_name || selected.slug : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
        {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
        {open && !disabled && tenants && (
          <div className="absolute left-0 z-20 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-lg">
            <label className="relative block border-b border-slate-100 p-2">
              <span className="sr-only">Search clients</span>
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, slug, or id…"
                className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-xs outline-none placeholder:text-slate-400 focus:border-slate-400"
              />
            </label>
            <div className="max-h-72 overflow-auto">{rows}</div>
            {overflowNote}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative inline-block w-[360px]" ref={boxRef}>
      <input
        type="text"
        className="w-full border rounded px-2 py-1 text-sm disabled:opacity-50"
        placeholder={tenants === null ? "Loading tenants…" : placeholder}
        disabled={disabled || tenants === null}
        value={open ? query : selected ? label(selected) : query}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {value && !open && !disabled && (
        <button
          type="button"
          aria-label="Clear tenant"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
          onClick={() => {
            onChange("");
            setQuery("");
          }}
        >
          ✕
        </button>
      )}
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
      {open && !disabled && tenants && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded border bg-white shadow text-sm">
          {rows}
          {overflowNote}
        </div>
      )}
    </div>
  );
}
