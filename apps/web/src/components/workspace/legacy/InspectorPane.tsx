"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { useActiveTenant } from "../brain/useActiveTenant";
import { scopeToTenant } from "../brain/tenantScope";
import { useWorkspace } from "../WorkspaceShell";
import type { InspectorContent } from "@/lib/workspace/types";
import { resolveCitation, type CitationPreview } from "@/lib/citations";
import { getAgentMeta } from "@/lib/agentRegistry";

export function InspectorPane() {
  const { tabs, activeTabId, inspectorByTab } = useWorkspace();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const explicit = inspectorByTab[activeTabId];
  const content: InspectorContent =
    explicit ??
    (() => {
      if (!activeTab) return { kind: "empty" };
      if (activeTab.kind === "agent") {
        return {
          kind: "agent_default",
          slug: (activeTab.payload as { slug: string }).slug,
        };
      }
      if (activeTab.kind === "home") return { kind: "home_default" };
      return { kind: "empty" };
    })();

  return (
    <div className="flex h-full flex-col px-4 py-4 text-[16px] leading-[1.55]">
      <h2 className="mb-4 text-[12px] font-semibold uppercase tracking-[0.12em] text-inkMuted">
        Inspector
      </h2>
      <div className="flex-1 overflow-y-auto">
        <InspectorContentRouter content={content} />
      </div>
    </div>
  );
}

function InspectorContentRouter({ content }: { content: InspectorContent }) {
  switch (content.kind) {
    case "agent_default":
      return <AgentMetaPanel slug={content.slug} />;
    case "citation_preview":
      return <CitationPreviewPanel content={content} />;
    case "entity":
      return <EntityPanel entityId={content.entityId} />;
    case "decision_context":
      return <DecisionPanel decisionId={content.decisionId} />;
    case "home_default":
      return <HomeContextPanel />;
    case "empty":
    default:
      return (
        <div className="text-inkMuted">
          Select an agent or click a citation to see context here.
        </div>
      );
  }
}

function AgentMetaPanel({ slug }: { slug: string }) {
  const meta = getAgentMeta(slug);
  return (
    <div className="space-y-3.5">
      <div>
        <div className="font-mono text-[14px] font-medium text-ink">{slug}</div>
        <div className="mt-0.5 text-[12px] font-medium uppercase tracking-wide text-inkMuted">
          {meta.department}
        </div>
      </div>
      <p className="text-[16px] leading-[1.55] text-ink">{meta.subtitle}</p>
      <p className="text-[13px] leading-[1.55] text-inkMuted">
        Runs · Policy · Feedback are inner tabs on the agent surface now.
        This pane shows context (citations, entities, decisions) when you
        click into them.
      </p>
    </div>
  );
}

function CitationPreviewPanel({
  content,
}: {
  content: Extract<InspectorContent, { kind: "citation_preview" }>;
}) {
  const [preview, setPreview] = useState<CitationPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const p = await resolveCitation(content.citation);
        if (!cancelled) setPreview(p);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content.citation]);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-4 w-1/2 animate-pulse rounded bg-bone" />
        <div className="h-20 animate-pulse rounded bg-bone" />
      </div>
    );
  }
  if (!preview || !preview.found) {
    return (
      <div className="text-inkMuted">
        Citation not found:{" "}
        <span className="font-mono">{content.citation.ref}</span>
      </div>
    );
  }
  if (preview.kind === "memory_doc") {
    return (
      <div className="space-y-2">
        <div className="font-mono text-[12px] uppercase tracking-wide text-inkMuted">
          memory_doc
        </div>
        <div className="font-mono text-[13px] text-ink">{preview.slug}</div>
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded bg-bone p-2 font-mono text-[11px] text-ink">
          {preview.body_markdown}
        </pre>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="font-mono text-[12px] uppercase tracking-wide text-inkMuted">
        agent_run
      </div>
      <div className="font-mono text-[13px] text-ink">
        {preview.agent_slug}
      </div>
      <div className="font-mono text-[11px] text-inkMuted">
        {preview.run_id.slice(0, 8)}… · {preview.status}
      </div>
      <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded bg-bone p-2 font-mono text-[11px] text-ink">
        {preview.output_text || "(no output_text)"}
      </pre>
    </div>
  );
}

function EntityPanel({ entityId }: { entityId: string }) {
  const [row, setRow] = useState<{
    entity_type: string;
    canonical_name: string;
    attrs: Record<string, unknown> | null;
    last_seen_at: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const tid = useActiveTenant();

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    if (tid === null) {
      setRow(null);
      setLoading(false);
      return;
    }
    const sb = createBrowserSupabase();
    scopeToTenant(
      sb
        .from("memory_entity")
        .select("entity_type, canonical_name, attrs, last_seen_at"),
      tid,
    )
      .eq("id", entityId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setRow(
            data as {
              entity_type: string;
              canonical_name: string;
              attrs: Record<string, unknown> | null;
              last_seen_at: string;
            } | null,
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, tid]);

  if (loading) {
    return <div className="h-20 animate-pulse rounded bg-bone" />;
  }
  if (!row) {
    return (
      <div className="text-inkMuted">
        Entity not found: <span className="font-mono">{entityId}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="font-mono text-[12px] uppercase tracking-wide text-inkMuted">
        {row.entity_type}
      </div>
      <div className="font-mono text-[13px] text-ink">
        {row.canonical_name}
      </div>
      <div className="text-[11px] text-inkMuted">
        last seen {new Date(row.last_seen_at).toLocaleString()}
      </div>
      {row.attrs && (
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded bg-bone p-2 font-mono text-[11px] text-ink">
          {JSON.stringify(row.attrs, null, 2)}
        </pre>
      )}
    </div>
  );
}

function DecisionPanel({ decisionId }: { decisionId: string }) {
  const [row, setRow] = useState<{
    decision_class: string;
    body: Record<string, unknown>;
    status: string;
    handler: string | null;
    emitted_at: string;
    agent_run_id: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const sb = createBrowserSupabase();
    sb.from("decisions")
      .select("decision_class, body, status, handler, emitted_at, agent_run_id")
      .eq("id", decisionId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setRow(
            data as {
              decision_class: string;
              body: Record<string, unknown>;
              status: string;
              handler: string | null;
              emitted_at: string;
              agent_run_id: string | null;
            } | null,
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [decisionId]);

  if (loading) {
    return <div className="h-20 animate-pulse rounded bg-bone" />;
  }
  if (!row) {
    return (
      <div className="text-inkMuted">
        Decision not found: <span className="font-mono">{decisionId}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="font-mono text-[12px] uppercase tracking-wide text-inkMuted">
        decision
      </div>
      <div className="font-mono text-[13px] text-ink">
        {row.decision_class}
      </div>
      <div className="font-mono text-[11px] text-inkMuted">
        status={row.status} · handler={row.handler ?? "-"}
      </div>
      <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded bg-bone p-2 font-mono text-[11px] text-ink">
        {JSON.stringify(row.body, null, 2)}
      </pre>
    </div>
  );
}

function HomeContextPanel() {
  return (
    <div className="space-y-4 text-[16px] text-ink">
      <div>
        <div className="text-[12px] font-semibold uppercase tracking-wide text-inkMuted">
          Quick actions
        </div>
      </div>
      <ul className="space-y-2">
        <li>
          <Link
            href="/connectors"
            className="text-ink hover:text-ink hover:underline underline-offset-2"
          >
            → Manage connectors
          </Link>
        </li>
        <li>
          <Link href="/workspace?tab=brain" className="text-ink hover:text-ink hover:underline underline-offset-2">
            → Company brain
          </Link>
        </li>
        <li>
          <Link
            href="/start"
            className="text-ink hover:text-ink hover:underline underline-offset-2"
          >
            → Re-run onboarding
          </Link>
        </li>
      </ul>
      <p className="mt-3 text-[13px] leading-[1.55] text-inkMuted">
        Click an agent in the Explorer for agent metadata. Click a citation
        chip in any chat for the cited source.
      </p>
    </div>
  );
}
