"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Playbook = {
  slug: string;
  title: string;
  outcome: string;
  agent_slug: string;
  data_used: string[];
  produces: string[];
  needs_approval: string[];
  est_credits: number;
};

const AGENT_LABEL: Record<string, string> = {
  operator: "Operator",
  "chief-of-staff": "Chief of Staff",
  "performance-marketer": "Performance Marketer",
};

export function PlaybooksClient() {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Record<string, string>>({});
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/playbooks");
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setError(b?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { playbooks: Playbook[] };
      if (isMounted.current) setPlaybooks(data.playbooks ?? []);
    } catch {
      if (isMounted.current) setError("Could not load playbooks.");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const launch = useCallback(async (slug: string) => {
    setBusySlug(slug);
    setError(null);
    try {
      const res = await apiFetch(`/api/playbooks/${slug}/launch`, { method: "POST", idempotent: true });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setError(b?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { playbook_run_id: string };
      if (isMounted.current) setLaunched((m) => ({ ...m, [slug]: data.playbook_run_id }));
    } catch {
      if (isMounted.current) setError("Could not launch this playbook.");
    } finally {
      if (isMounted.current) setBusySlug(null);
    }
  }, []);

  if (loading) {
    return <p className="text-[16px] text-inkMuted">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-[13px] text-red-700">{error}</p> : null}
      {playbooks.length === 0 ? (
        <p className="rounded-xl border border-[#e6dfd2] bg-white p-4 text-[16px] text-inkMuted">
          No playbooks available yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {playbooks.map((p) => {
            const isLaunched = Boolean(launched[p.slug]);
            return (
              <li key={p.slug} className="rounded-xl border border-[#e6dfd2] bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-[12px] text-inkMuted">
                      <span className="rounded bg-bone px-1.5 py-0.5">{AGENT_LABEL[p.agent_slug] ?? p.agent_slug}</span>
                      <span>· ~{p.est_credits.toLocaleString()} credits</span>
                    </div>
                    <p className="text-[14px] font-semibold tracking-tight text-ink">{p.title}</p>
                    <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">{p.outcome}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void launch(p.slug)}
                    disabled={busySlug === p.slug || isLaunched}
                    className="shrink-0 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-50"
                  >
                    {isLaunched ? "Launched" : busySlug === p.slug ? "Launching…" : "Launch"}
                  </button>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-3">
                  <CatalogField label="Uses" items={p.data_used} />
                  <CatalogField label="Produces" items={p.produces} />
                  <CatalogField label="You approve" items={p.needs_approval} />
                </dl>

                {isLaunched ? (
                  <p className="mt-3 border-l-2 border-[#e6dfd2] pl-2 text-[12px] italic text-inkMuted">
                    Running. Your agents will bring a decision card here and in Slack when there&rsquo;s something to
                    approve.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CatalogField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="font-medium text-ink">{label}</dt>
      <dd className="mt-0.5 text-inkMuted">
        <ul className="space-y-0.5">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
