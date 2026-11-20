"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { NextChevron } from "@/components/ui/NextChevron";

type Artifact = {
  id: string;
  kind: "memory_update" | "skill_patch" | "new_agent_draft";
  target_slug: string;
  rationale: string;
  proposed: Record<string, unknown>;
  status: string;
  created_at: string;
  source_event_id: string | null;
};

export function ArtifactsIsland() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch("/api/artifacts");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setItems((r.artifacts ?? []) as Artifact[]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    function onVisibility() {
      if (!document.hidden) void load();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function decide(id: string, action: "apply" | "reject") {
    setBusy(id);
    try {
      const res = await apiFetch(`/api/artifacts/${id}/${action}`, { method: "POST" });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setItems((d) => d.filter((x) => x.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">{error}</div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-[16px] text-slate-600 text-center">
        <p>
          No proposals yet. <a href="/connectors" className="underline font-medium text-skyMuted hover:text-brickDark">Connect a tool</a>{" "}
          (Slack first) and the extractor will start surfacing memory updates, skill patches, and agent drafts here
          as your operations stream in.
        </p>
        <a
          href="/connectors"
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-skyMuted text-white px-3.5 py-1.5 text-[13px] font-medium hover:bg-brickDark transition-colors"
        >
          Go to Connectors <NextChevron />
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((a) => (
        <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="flex items-center gap-2">
                <span className={kindBadge(a.kind)}>{a.kind}</span>
                <span className="font-mono text-[13px] font-semibold text-slate-900">{a.target_slug}</span>
              </div>
              <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                proposed {new Date(a.created_at).toLocaleString()}
              </div>
            </div>
            {confirming === a.id ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirming(null)}
                  disabled={busy === a.id}
                  className="inline-flex items-center rounded-cta border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => decide(a.id, "apply")}
                  disabled={busy === a.id}
                  className="inline-flex items-center rounded-cta border border-transparent bg-brickDark text-white px-4 py-1.5 text-[12px] font-medium hover:bg-brick shadow-sm disabled:opacity-50"
                >
                  {busy === a.id ? "…" : "Confirm write-through"}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => decide(a.id, "reject")}
                  disabled={busy === a.id}
                  className="inline-flex items-center rounded-cta border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-rose-300 hover:text-rose-700 disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  onClick={() => setConfirming(a.id)}
                  disabled={busy === a.id}
                  className="inline-flex items-center rounded-cta border border-transparent bg-skyMuted text-white px-4 py-1.5 text-[12px] font-medium hover:bg-brickDark shadow-sm disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
          {a.rationale && (
            <div className="mt-2 text-[13px] text-slate-700 italic leading-[1.5]">{a.rationale}</div>
          )}
          {confirming === a.id && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 leading-[1.5]">
              {a.kind === "skill_patch"
                ? `This applies the changes below to ${a.target_slug}'s instructions. Review the diff, then confirm.`
                : `This applies this ${a.kind.replace(/_/g, " ")} to ${a.target_slug}. Confirm to write it through.`}
            </div>
          )}
          {renderProposed(a)}
        </div>
      ))}
    </div>
  );
}

function kindBadge(k: Artifact["kind"]): string {
  const base = "text-[11px] font-mono uppercase tracking-[0.14em] rounded-full px-2 py-0.5";
  if (k === "memory_update") return `${base} bg-emerald-100 text-emerald-800`;
  if (k === "skill_patch") return `${base} bg-amber-100 text-amber-800`;
  return `${base} bg-bone text-ink`;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function renderProposed(a: Artifact) {
  const before = asString(a.proposed.current_body);
  const after = asString(a.proposed.proposed_body);
  if (a.kind === "skill_patch" && before !== null && after !== null) {
    const rest = Object.fromEntries(
      Object.entries(a.proposed).filter(([k]) => k !== "current_body" && k !== "proposed_body"),
    );
    const hasRest = Object.keys(rest).length > 0;
    return (
      <div className="mt-2">
        <InstructionDiff before={before} after={after} />
        {hasRest && (
          <>
            <div className="mt-2 text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500">
              Other changes
            </div>
            <pre className="mt-1 rounded-md bg-slate-50 p-3 text-[12px] text-slate-700 leading-[1.5] overflow-auto max-h-40">
              {JSON.stringify(rest, null, 2)}
            </pre>
          </>
        )}
      </div>
    );
  }
  return (
    <pre className="mt-2 rounded-md bg-slate-50 p-3 text-[12px] text-slate-700 leading-[1.5] overflow-auto max-h-72">
      {JSON.stringify(a.proposed, null, 2)}
    </pre>
  );
}

type DiffLine = { type: "ctx" | "add" | "del"; text: string };

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function InstructionDiff({ before, after }: { before: string; after: string }) {
  if (before === after) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
        No change to the instruction text.
      </div>
    );
  }
  const lines = lineDiff(before, after);
  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500">
        <span><span className="text-rose-600">−</span> before</span>
        <span><span className="text-emerald-600">+</span> after</span>
      </div>
      <pre className="bg-white text-[12px] leading-[1.55] overflow-auto max-h-80 m-0">
        {lines.map((ln, idx) => (
          <div
            key={idx}
            className={
              ln.type === "add"
                ? "px-3 bg-emerald-50 text-emerald-900"
                : ln.type === "del"
                  ? "px-3 bg-rose-50 text-rose-900"
                  : "px-3 text-slate-600"
            }
          >
            <span className="select-none text-slate-400">
              {ln.type === "add" ? "+ " : ln.type === "del" ? "− " : "  "}
            </span>
            {ln.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
