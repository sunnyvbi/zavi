"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { FeedbackForm } from "@/components/admin/FeedbackForm";
import { adminApiFetch } from "@/lib/api-admin";

type Decision = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: unknown;
  status: string;
  autonomy_at_emit: string | null;
  handler: string | null;
  emitted_at: string;
  approved_at: string | null;
  approved_by: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
};

type ParentRun = {
  id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  output_text: string | null;
};

export default function AdminDecisionDetailPage() {
  return <Body />;
}

function Body() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [decision, setDecision] = useState<Decision | null>(null);
  const [run, setRun] = useState<ParentRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/decisions/${id}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setDecision(r.decision as Decision);
        setRun((r.run ?? null) as ParentRun | null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      </div>
    );
  }
  if (!decision) {
    return <div className="max-w-5xl mx-auto p-6 text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin · decision
        </div>
        <h1 className="font-display font-semibold text-xl text-slate-900 mt-1">
          {decision.decision_class}
        </h1>
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm text-slate-600">
          <span>
            Tenant{" "}
            <Link href={`/tenants/${decision.tenant_id}`} className="font-mono hover:underline">
              {decision.tenant_id.slice(0, 8)}
            </Link>
          </span>
          <span>Status <span>{decision.status}</span></span>
          <span>Autonomy <span>{decision.autonomy_at_emit ?? "—"}</span></span>
          <span>Handler <span>{decision.handler ?? "—"}</span></span>
          {run && (
            <span>
              Run{" "}
              <Link href={`/runs/${run.id}`} className="hover:underline">
                {run.agent_slug}
              </Link>
            </span>
          )}
        </div>
      </div>

      <FeedbackForm targetType="decision" targetId={decision.id} />

      <Section title="Body">
        <pre className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-mono whitespace-pre-wrap break-words text-slate-800 max-h-[480px] overflow-auto">
          {JSON.stringify(decision.body, null, 2)}
        </pre>
      </Section>

      {decision.dispatch_error && (
        <Section title="Dispatch error">
          <pre className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-mono whitespace-pre-wrap break-words text-rose-900">
            {decision.dispatch_error}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500 mb-2">
        {title}
      </div>
      {children}
    </section>
  );
}
