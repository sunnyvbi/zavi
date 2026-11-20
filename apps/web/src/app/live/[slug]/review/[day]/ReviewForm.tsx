"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/api";
import type { DayKind, PublicDay } from "@/lib/marketing/liveUpcar";

const TAGS: [DayKind, string][] = [
  ["PLAN", "Plan"], ["CHANGE", "Change"], ["WIN", "Worked"], ["LOSS", "Flopped"],
  ["HUMAN", "A person did this"], ["NOT_AVAILABLE", "Couldn't do it"], ["WORK", "Groundwork"],
];

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; action: "publish" | "hide" } | { kind: "error"; message: string };

export function ReviewForm({ slug, day, token, full, neutral, expiresAt }: { slug: string; day: string; token: string; full: PublicDay; neutral: PublicDay; expiresAt: string }) {
  const [kind, setKind] = useState<DayKind>(full.kind);
  const [headline, setHeadline] = useState(full.headline);
  const [why, setWhy] = useState(full.why ?? "");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function send(action: "publish" | "hide") {
    setState({ kind: "sending" });
    try {
      const res = await fetch(apiUrl(`/api/public/live/${slug}/review/${encodeURIComponent(day)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, action, kind, headline, why }),
      });
      if (res.ok) return setState({ kind: "done", action });
      if (res.status === 422) {
        const j = (await res.json().catch(() => ({}))) as { matches?: string[] };
        return setState({ kind: "error", message: `Remove this before publishing, it looks like an account or ad id: ${(j.matches ?? []).join(", ")}` });
      }
      if (res.status === 404) return setState({ kind: "error", message: "This link was already used or has expired." });
      if (res.status === 429) return setState({ kind: "error", message: "Too many tries. Wait a minute and try again." });
      return setState({ kind: "error", message: "Something went wrong. Try again in a minute." });
    } catch {
      return setState({ kind: "error", message: "Couldn't reach Zavi. Check your connection and try again." });
    }
  }

  if (state.kind === "done") {
    return (
      <div className="mt-6 border-t border-[#0e0f11]/12 pt-6">
        <p className="text-[20px] font-semibold">{state.action === "publish" ? "Published." : "Hidden."}</p>
        <p className="mt-2 text-[14px] text-[#3a3d42]">
          {state.action === "publish" ? "It shows on " : "It won't show on "}
          <a className="underline" href={`/live/${slug}`}>/live/{slug}</a>
          {state.action === "publish" ? " within the hour." : "."}
        </p>
      </div>
    );
  }

  const busy = state.kind === "sending";
  return (
    <div className="mt-4">
      <h1 className="text-[26px] font-bold tracking-tight">Day entry for {day}</h1>
      <p className="mt-1 text-[14px] text-[#6b7076]">Nothing is public until you press Publish. This link works once{expiresAt ? `, until ${new Date(expiresAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ""}.</p>

      <fieldset className="mt-6">
        <legend className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Tag</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {TAGS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
              className={`border px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase ${kind === k ? "border-[#0e0f11] bg-[#0e0f11] text-white" : "border-[#0e0f11]/20 bg-white"}`}>
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-5 block">
        <span className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Headline</span>
        <input value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={200} className="mt-2 w-full border border-[#0e0f11]/20 bg-white px-3 py-2 text-[14px]" />
      </label>
      <label className="mt-4 block">
        <span className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Why (Zavi&apos;s reason)</span>
        <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={600} rows={3} className="mt-2 w-full border border-[#0e0f11]/20 bg-white px-3 py-2 text-[14px]" />
      </label>

      <div className="mt-5 grid gap-4 border-t border-[#0e0f11]/12 pt-4 sm:grid-cols-2">
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">What Zavi did</p>
          <ol className="mt-2 list-decimal pl-5 text-[14px] text-[#3a3d42]">{full.work.map((w) => <li key={w}>{w}</li>)}</ol>
          {full.work.length === 0 && <p className="mt-2 text-[14px] text-[#6b7076]">Nothing recorded.</p>}
        </div>
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-[0.12em] text-[#6b7076] uppercase">Budget changes</p>
          {full.budget.length === 0 ? <p className="mt-2 text-[14px] text-[#6b7076]">None.</p> : (
            <ul className="mt-2 text-[14px]">{full.budget.map((b, i) => <li key={i}>{b.channel}: {b.from_usd ?? "?"} → {b.to_usd ?? "?"} $/day</li>)}</ul>
          )}
        </div>
      </div>
      <p className="mt-4 text-[13px] text-[#6b7076]">Before the numbers go public, the page shows: <b className="text-[#0e0f11]">{neutral.headline}</b> (your edits appear only after the unlock).</p>

      {state.kind === "error" && <p role="alert" className="mt-4 border border-[#8c3a1e]/40 bg-[#8c3a1e]/5 px-3 py-2 text-[14px] text-[#8c3a1e]">{state.message}</p>}

      <div className="mt-6 flex gap-3">
        <button type="button" disabled={busy || !headline.trim()} onClick={() => send("publish")} className="min-h-11 bg-[#0e0f11] px-4 text-[14px] font-semibold text-white disabled:opacity-50">Publish</button>
        <button type="button" disabled={busy} onClick={() => send("hide")} className="min-h-11 border border-[#0e0f11]/25 bg-white px-4 text-[14px] font-semibold disabled:opacity-50">Hide</button>
      </div>
    </div>
  );
}
