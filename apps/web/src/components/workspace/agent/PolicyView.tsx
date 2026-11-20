"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { NextChevron } from "@/components/ui/NextChevron";

type PolicyRow = {
  slug: string;
  frontmatter: Record<string, unknown> | null;
  body_markdown: string | null;
};

export function PolicyView({ slug }: { slug: string }) {
  const [policy, setPolicy] = useState<PolicyRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [hideRow, setHideRow] = useState<{ source: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    const sb = createBrowserSupabase();
    sb.from("tenant_agents")
      .select("slug, frontmatter, body_markdown")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setErrorMsg(error.message);
        } else {
          setPolicy(data as PolicyRow | null);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    const sb = createBrowserSupabase();
    sb.from("tenant_agent_kill_switch")
      .select("source")
      .eq("agent_slug", slug)
      .eq("source", "staff")
      .eq("override_state", "hidden")
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setHideRow((data as { source: string } | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const lockedByStaff = hideRow?.source === "staff";

  if (loading) {
    return (
      <div role="status" aria-label="Loading policy" className="space-y-5">
        <div className="space-y-2">
          <div className="h-5 w-20 animate-pulse rounded bg-bone" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-bone" />
        </div>
        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <div className="mb-3 h-4 w-20 animate-pulse rounded bg-bone" />
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="grid grid-cols-[160px_1fr] gap-x-4">
                <div className="h-3 w-24 animate-pulse rounded bg-bone" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-bone" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <div className="mb-3 h-4 w-28 animate-pulse rounded bg-bone" />
          <div className="h-40 w-full animate-pulse rounded bg-bone" />
        </div>
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
        Couldn&apos;t load policy: {errorMsg}
      </div>
    );
  }

  const fm = (policy?.frontmatter ?? {}) as Record<string, unknown>;
  const killSwitch = ((fm.kill_switch as boolean | undefined) ?? true) === true;
  const owner = (fm.owner as string | undefined) ?? "-";
  const model = (fm.model as string | undefined) ?? "-";
  const costClass = (fm.cost_class as string | undefined) ?? "-";
  const outputEnvelope = (fm.output_envelope as string | undefined) ?? null;
  const requiresSandbox =
    ((fm.requires_sandbox as boolean | undefined) ?? false) === true;
  const memoryLayer =
    ((fm.memory_layer as boolean | undefined) ?? true) === true;
  const tools = ((fm.tools as string[] | undefined) ?? []).filter(Boolean);
  const autoApprove = fm.auto_approve_thresholds ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 font-display text-[16px] font-semibold text-ink">
          Policy
        </h2>
        <p className="text-[12px] text-inkMuted">
          Read-only view of the active tenant policy. Inline edit ships in
          the policy editor (next phase). For now, fork via the legacy
          editor to customize.
        </p>
      </div>

      <section className="rounded-lg border border-ink/10 bg-white p-4">
        <h3 className="mb-3 font-display text-[16px] font-semibold text-ink">
          Settings
        </h3>
        <dl className="grid grid-cols-1 gap-y-1.5 text-[13px] sm:grid-cols-[160px_1fr] sm:gap-x-4">
          <Row label="Kill-switch">
            <span
              className={`inline-flex items-center gap-2 rounded px-1.5 py-0.5 font-mono text-[11px] ${
                killSwitch
                  ? "bg-emerald-100 text-emerald-900"
                  : "bg-rose-100 text-rose-900"
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  killSwitch ? "bg-emerald-600" : "bg-rose-600"
                }`}
              />
              {killSwitch ? "enabled" : "disabled"}
            </span>
          </Row>
          {}
          <Row label="Visibility">
            <span className="inline-flex items-center gap-2">
              <span className="font-mono text-[11px] text-ink">
                {lockedByStaff ? "hidden for this workspace" : "visible"}
              </span>
              {lockedByStaff && (
                <span className="text-[11px] text-inkMuted">Managed by Zavi</span>
              )}
            </span>
          </Row>
          <Row label="Owner">
            <span className="font-mono text-ink">{owner}</span>
          </Row>
          <Row label="Model">
            <span className="font-mono text-ink">{model}</span>
          </Row>
          <Row label="Cost class">
            <span className="font-mono text-ink">{costClass}</span>
          </Row>
          <Row label="Output envelope">
            <span className="font-mono text-ink">
              {outputEnvelope ?? "-"}
            </span>
          </Row>
          <Row label="Requires sandbox">
            <span className="font-mono text-ink">
              {requiresSandbox ? "yes" : "no"}
            </span>
          </Row>
          <Row label="Memory layer">
            <span className="font-mono text-ink">
              {memoryLayer ? "enabled" : "disabled"}
            </span>
          </Row>
          <Row label="Tools">
            <span className="font-mono text-ink">
              {tools.length > 0 ? tools.join(", ") : "-"}
            </span>
          </Row>
          {autoApprove != null && (
            <Row label="Auto-approve">
              <pre className="whitespace-pre-wrap rounded bg-bone px-2 py-1 font-mono text-[11px] text-ink">
                {JSON.stringify(autoApprove, null, 2)}
              </pre>
            </Row>
          )}
        </dl>
        <div className="mt-4 flex items-center gap-3">
          <Link
            href={`/agents/${encodeURIComponent(slug)}/edit`}
            className="rounded-md border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink/30"
          >
            Open editor <NextChevron />
          </Link>
          <span className="text-[11px] text-inkMuted">
            (legacy editor route stays mounted until inline edit ships)
          </span>
        </div>
      </section>

      <section className="rounded-lg border border-ink/10 bg-white p-4">
        <h3 className="mb-3 font-display text-[16px] font-semibold text-ink">
          System prompt
        </h3>
        {policy?.body_markdown ? (
          <pre className="max-h-[500px] overflow-y-auto whitespace-pre-wrap rounded bg-bone p-3 font-mono text-[12px] leading-[1.55] text-ink">
            {policy.body_markdown}
          </pre>
        ) : (
          <div className="text-[13px] text-inkMuted">
            Using the platform default policy. Fork this agent to customize.
          </div>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-inkMuted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}
