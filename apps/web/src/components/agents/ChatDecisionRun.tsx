"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CardOriginLine, type DecisionBody } from "./ApprovalBlock";
import { originLabel } from "@/lib/workspace/threadTimeline";
import { LiveDecisionCard } from "./LiveDecisionCard";
import { cutsFirst, moveHeader, moveKeyOf, type MoveCardRow } from "./moneyCards";
import { fetchDecision, type LiveDecisionRow } from "@/lib/approvals/decisionApi";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";

export function MoveHeader({ rows }: { rows: MoveCardRow[] }) {
  const h = moveHeader(rows);
  return (
    <div data-testid="move-header" className="overflow-hidden rounded-2xl border border-[#efe2c3] bg-[#fbf6ea] px-4 pb-3 pt-3 shadow-[0_1px_2px_rgba(43,36,22,0.06)]">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[#a8977a]">
        This move · {h.count} changes
        <span className="ml-auto font-semibold normal-case tracking-normal tabular-nums">
          {h.decided} of {h.count} decided
        </span>
      </div>
      {h.total && <p className="mt-1 text-[26px] font-extrabold leading-8 tracking-[-0.02em] text-[#2b2416] tabular-nums">{h.total}</p>}
      <p className={`mt-0.5 text-[12.5px] leading-snug ${h.tone === "up" ? "font-medium text-[#8a5a10]" : "text-[#595959]"}`}>{h.status}</p>
    </div>
  );
}

type Item = { body: DecisionBody; node: ReactNode };

export function ChatDecisionRun({ items }: { items: Item[] }) {
  const viewerRole = useWorkspaceOptional()?.role ?? null;
  const ids = useMemo(() => items.filter((i) => i.body.store !== "channel_action").map((i) => i.body.decision_id), [items]);
  const idsKey = ids.join(",");
  const [rows, setRows] = useState<Record<string, LiveDecisionRow> | null>(null);
  const [inMove, setInMove] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    void Promise.all(ids.map((id) => fetchDecision(id))).then((got) => {
      if (!live) return;
      const out: Record<string, LiveDecisionRow> = {};
      const moved = new Set<string>();
      for (const g of got)
        if (g.ok) {
          out[g.decision.id] = g.decision;
          if (g.move) moved.add(g.decision.id);
        }
      setInMove(moved);
      setRows(out);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  const onRow = useCallback((row: LiveDecisionRow) => setRows((r) => ({ ...(r ?? {}), [row.id]: row })), []);

  if (rows === null) return <p className="text-[12px] text-inkMuted">Loading the actions…</p>;

  const byMove = new Map<string, LiveDecisionRow[]>();
  for (const i of items) {
    const r = rows[i.body.decision_id];
    const k = r ? moveKeyOf(r.body) : null;
    if (k) byMove.set(k, [...(byMove.get(k) ?? []), r!]);
  }
  const out: ReactNode[] = [];
  const shown = new Set<string>();
  for (const i of items) {
    const r = rows[i.body.decision_id];
    const k = r ? moveKeyOf(r.body) : null;
    const group = k ? byMove.get(k) : undefined;
    if (!k || !group || group.length < 2) {
      out.push(<div key={i.body.decision_id}>{i.node}</div>);
      continue;
    }
    if (shown.has(k)) continue;
    shown.add(k);
    const origin = items.filter((x) => group.some((g) => g.id === x.body.decision_id)).map((x) => originLabel(x.body)).find((l) => l) ?? null;
    if (group.some((g) => inMove.has(g.id))) {
      const first = group[0];
      const item = items.find((x) => x.body.decision_id === first.id);
      out.push(
        <div key={`move:${k}`} data-testid="move-group">
          <CardOriginLine label={origin} />
          <LiveDecisionCard decisionId={first.id} title={item?.body.title ?? ""} viewerRole={viewerRole} surface="chat" runStopped={item?.body.run_stopped === true} shownAt={item?.body.shown_at} onRow={onRow} />
        </div>,
      );
      continue;
    }
    out.push(
      <div key={`move:${k}`} data-testid="move-group" className="space-y-2.5">
        <CardOriginLine label={origin} />
        <MoveHeader rows={group} />
        {cutsFirst(group).map((g) => (
          <LiveDecisionCard
            key={g.id}
            decisionId={g.id}
            title={items.find((x) => x.body.decision_id === g.id)?.body.title ?? ""}
            viewerRole={viewerRole}
            surface="chat"
            runStopped={items.find((x) => x.body.decision_id === g.id)?.body.run_stopped === true}
            shownAt={items.find((x) => x.body.decision_id === g.id)?.body.shown_at}
            onRow={onRow}
          />
        ))}
      </div>,
    );
  }
  return <div className="space-y-5">{out}</div>;
}
