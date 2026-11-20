"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import type { CampaignContextRow, DecisionBrief } from "@/components/agents/decisionSupport";
import type { FreshProposal } from "@/components/agents/triageStage";
import { LegacyProposalList } from "./LegacyProposalList";
import { TriageReviewer } from "./TriageReviewer";

type Decision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  status: string;
  agent_slug?: string | null;
  emitted_at: string;
  dispatched_at: string | null;
  dispatch_error: string | null;
  revision?: {
    id: string;
    status: string;
    message: string;
    assistant_text: string | null;
    replacement_decision_id: string | null;
    last_error?: string | null;
    created_at: string;
  } | null;
  brief?: DecisionBrief | null;
};

type Bucket = { key: string; label: string; items: Decision[] };

type RecentConversation = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  decision_status: string;
  last_message: string;
  last_at: string;
};

type AgentStateSnapshot = {
  buckets: Bucket[];
  total: number;
  recent: RecentConversation[];
  triageFocus: boolean;
};
const STATE_CACHE = new Map<string, AgentStateSnapshot>();

function isRevisionActive(d: Decision): boolean {
  return d.revision?.status === "requested" || d.revision?.status === "running";
}

async function decideErrorMessage(res: Response | null): Promise<string> {
  try {
    const j = (await res?.json()) as { error?: { message?: string } } | undefined;
    if (j?.error?.message) return j.error.message;
  } catch {
  }
  return "Didn't go through. Try again.";
}

export function PerfMarketerAgentState({
  campaigns,
  windowLabel,
  pixelDegraded,
}: {
  campaigns?: CampaignContextRow[];
  windowLabel?: string;
  pixelDegraded?: boolean;
} = {}) {
  const { tenantName } = useWorkspace();
  const seedKey = tenantName ?? "_";
  const [buckets, setBuckets] = useState<Bucket[]>(
    () => STATE_CACHE.get(seedKey)?.buckets ?? [],
  );
  const [total, setTotal] = useState(() => STATE_CACHE.get(seedKey)?.total ?? 0);
  const [recent, setRecent] = useState<RecentConversation[]>(
    () => STATE_CACHE.get(seedKey)?.recent ?? [],
  );
  const [triageFocus, setTriageFocus] = useState(
    () => STATE_CACHE.get(seedKey)?.triageFocus ?? false,
  );
  const [loading, setLoading] = useState(() => !STATE_CACHE.has(seedKey));
  const [actingId, setActingId] = useState<string | null>(null);
  const [actErrors, setActErrors] = useState<Record<string, string>>({});
  const [modifyingId, setModifyingId] = useState<string | null>(null);
  const [openConvoId, setOpenConvoId] = useState<string | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armReject = useCallback((id: string | null) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmRejectId(id);
    if (id) {
      confirmTimer.current = setTimeout(() => setConfirmRejectId(null), 3500);
    }
  }, []);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    const key = tenantName ?? "_";
    if (!STATE_CACHE.has(key)) setLoading(true);
    try {
      const pRes = await apiFetch("/api/agents/performance-marketer/proposals");
      const snap: AgentStateSnapshot = { buckets: [], total: 0, recent: [], triageFocus: false };
      if (pRes.ok) {
        const j = (await pRes.json()) as {
          buckets?: Bucket[];
          total?: number;
          recent_conversations?: RecentConversation[];
          triage_focus?: boolean;
        };
        snap.buckets = j.buckets ?? [];
        snap.total = j.total ?? 0;
        snap.recent = j.recent_conversations ?? [];
        snap.triageFocus = j.triage_focus === true;
        setBuckets(snap.buckets);
        setTotal(snap.total);
        setRecent(snap.recent);
        setTriageFocus(snap.triageFocus);
      }
      STATE_CACHE.set(key, snap);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [tenantName]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActiveRevision = buckets.some((bucket) =>
    bucket.items.some((d) => isRevisionActive(d)),
  );
  useEffect(() => {
    if (!hasActiveRevision) return;
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [hasActiveRevision, load]);

  const act = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setActingId(id);
      setActErrors((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
      try {
        const res = await apiFetch(`/api/approvals/${id}/${action}`, { method: "POST" });
        if (!res.ok) {
          const msg = await decideErrorMessage(res);
          setActErrors((prev) => ({ ...prev, [id]: msg }));
        }
        await load();
      } catch {
        setActErrors((prev) => ({
          ...prev,
          [id]: "Network error. Nothing was applied. Try again.",
        }));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const refetchProposals = useCallback(async (): Promise<FreshProposal[]> => {
    const res = await apiFetch("/api/agents/performance-marketer/proposals");
    if (!res.ok) return [];
    const j = (await res.json()) as { buckets?: Bucket[] };
    const out: FreshProposal[] = [];
    for (const b of j.buckets ?? []) {
      for (const d of b.items) {
        out.push({
          id: d.id,
          status: d.status,
          emitted_at: d.emitted_at,
          body: d.body ?? {},
          revisionActive: isRevisionActive(d),
        });
      }
    }
    return out;
  }, []);

  const postDecision = useCallback(
    async (
      id: string,
      action: "approve" | "reject",
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        const res = await apiFetch(`/api/approvals/${id}/${action}`, { method: "POST" });
        if (res.ok) return { ok: true };
        return { ok: false, message: await decideErrorMessage(res) };
      } catch {
        return { ok: false, message: "Network error. Nothing was applied. Try again." };
      }
    },
    [],
  );

  if (loading && total === 0 && recent.length === 0) return null;
  if (total === 0 && recent.length === 0) return null;

  if (triageFocus) {
    return (
      <div className="flex flex-col gap-4">
        {total > 0 && (
          <TriageReviewer
            buckets={buckets}
            total={total}
            campaigns={campaigns}
            windowLabel={windowLabel}
            pixelDegraded={pixelDegraded}
            modifyingId={modifyingId}
            setModifyingId={setModifyingId}
            armReject={armReject}
            load={load}
            refetchProposals={refetchProposals}
            postDecision={postDecision}
          />
        )}
        {}
        {recent.length > 0 && (
          <LegacyProposalList
            buckets={[]}
            total={0}
            recent={recent}
            actingId={actingId}
            modifyingId={modifyingId}
            setModifyingId={setModifyingId}
            openConvoId={openConvoId}
            setOpenConvoId={setOpenConvoId}
            confirmRejectId={confirmRejectId}
            armReject={armReject}
            act={act}
            load={load}
          />
        )}
      </div>
    );
  }

  return (
    <LegacyProposalList
      buckets={buckets}
      total={total}
      recent={recent}
      actingId={actingId}
      actErrors={actErrors}
      modifyingId={modifyingId}
      setModifyingId={setModifyingId}
      openConvoId={openConvoId}
      setOpenConvoId={setOpenConvoId}
      confirmRejectId={confirmRejectId}
      armReject={armReject}
      act={act}
      load={load}
    />
  );
}
