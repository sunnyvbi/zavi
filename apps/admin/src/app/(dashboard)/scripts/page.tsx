"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/admin/PageHeader";
import { ScriptRunner } from "@/components/admin/scripts/ScriptRunner";
import { fetchScripts, type ScriptInfo, type ScriptRun } from "@/lib/scripts-api";

function ScriptsPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null);
  const [runs, setRuns] = useState<Record<string, ScriptRun[]>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await fetchScripts();
      setScripts(body.scripts);
      setRuns(body.runs ?? {});
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedKey = params.get("script") ?? scripts?.[0]?.key ?? null;
  const selected = scripts?.find((s) => s.key === selectedKey) ?? null;

  const groups = new Map<string, ScriptInfo[]>();
  for (const s of scripts ?? []) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="Scripts"
        subtitle="Run operational scripts with the production backend's own settings. Dry Run first; Apply needs a typed confirmation and is audit-logged."
      />
      {err && <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{err}</div>}
      {scripts === null ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="flex flex-col gap-6 md:flex-row">
          <nav className="w-full shrink-0 md:w-56">
            {[...groups.entries()].map(([group, items]) => (
              <div key={group} className="mb-4">
                <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">{group}</div>
                <ul className="space-y-1">
                  {items.map((s) => (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => router.replace(`/scripts?script=${encodeURIComponent(s.key)}`)}
                        className={
                          "w-full rounded-md px-3 py-2 text-left text-sm " +
                          (s.key === selectedKey ? "bg-sky-100 font-medium text-sky-900" : "text-slate-700 hover:bg-slate-100")
                        }
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            {selected ? (
              <ScriptRunner script={selected} runs={runs[selected.key] ?? []} onRunsChanged={() => void load()} />
            ) : (
              <p className="text-sm text-slate-500">Pick a script.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ScriptsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
      <ScriptsPageInner />
    </Suspense>
  );
}
