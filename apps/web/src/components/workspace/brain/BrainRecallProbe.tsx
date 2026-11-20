"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, Mic, Zap, Play, User, Slack, Github, Mail, type LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { NextChevron } from "@/components/ui/NextChevron";

type SearchHit = {
  chunk_id: string;
  note_id: string;
  title: string;
  body: string;
  score: number;
  source?: string;
  note_type?: string;
  created_at?: string;
  trust_tier?: number | null;
  agent_slug?: string | null;
};

type ProbeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "results"; query: string; hits: SearchHit[] };

const CHANNEL_ICON: Record<string, LucideIcon> = { Slack, GitHub: Github, Email: Mail };

function channelLabel(source: string | null | undefined): string {
  const s = (source ?? "").toLowerCase();
  if (s.includes("slack")) return "Slack";
  if (s.includes("github")) return "GitHub";
  if (s.includes("gmail") || s.includes("email")) return "Email";
  if (s.includes("meta") || s.includes("ads") || s.includes("facebook")) return "Meta Ads";
  if (s.includes("stripe")) return "Stripe";
  if (s.includes("operator_db") || s.includes("mongo") || s.includes("db")) return "Your database";
  if (s.includes("agent") || s.includes("distill") || s.includes("run") || s.includes("chat")) return "Agent run";
  if (!s) return "Memory";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/[_-]+/g, " ");
}

function timeLabel(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function Badge({ icon: Icon, label, iconClass }: { icon: LucideIcon; label: string; iconClass?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-inkSoft">
      <Icon aria-hidden strokeWidth={1.75} className={`h-3.5 w-3.5 ${iconClass ?? "text-inkMuted"}`} />
      {label}
    </span>
  );
}

export function BrainRecallProbe() {
  const [input, setInput] = useState("");
  const [state, setState] = useState<ProbeState>({ kind: "idle" });

  async function runProbe() {
    const q = input.trim();
    if (q.length === 0) return;
    setState({ kind: "loading" });
    try {
      const res = await apiFetch("/api/memory/search", {
        method: "POST",
        body: JSON.stringify({ query: q, k: 8 }),
      });
      if (!res.ok) {
        let code: string | undefined;
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          code = body.error?.code;
        } catch {
        }
        setState({ kind: "error", message: errorCopy(res.status, code) });
        return;
      }
      const body = (await res.json()) as { hits?: SearchHit[] };
      setState({ kind: "results", query: q, hits: body.hits ?? [] });
    } catch {
      setState({
        kind: "error",
        message: "Couldn't reach the brain. Check your connection and try again.",
      });
    }
  }

  const asking = state.kind === "loading";

  return (
    <section className="mb-6">
      <h2 className="text-center font-display text-[24px] font-bold leading-[34px] tracking-tight text-ink">
        Ask your brain
      </h2>
      <p className="mx-auto mb-4 mt-1 max-w-xl text-center text-[16px] leading-[20px] text-inkMuted">
        Type a question to see exactly what your fleet would recall when an agent answers.
      </p>

      {}
      <div className="flex items-center gap-2 rounded-[16px] border border-ink/12 bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(25,25,25,0.03)] focus-within:border-ink/35">
        <Sparkles aria-hidden strokeWidth={1.75} className="h-[18px] w-[18px] shrink-0 text-inkMuted" />
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runProbe();
            }
          }}
          placeholder='Ask your brain a question, e.g. "What our website URL"…'
          aria-label="Ask your brain a question"
          className="min-w-0 flex-1 bg-transparent text-[16px] tracking-[-0.15px] text-ink outline-none placeholder:text-inkMuted"
        />
        <Mic aria-hidden strokeWidth={1.75} className="h-[18px] w-[18px] shrink-0 text-inkMuted" />
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={asking || input.trim().length === 0}
          className="inline-flex shrink-0 items-center gap-2 rounded-cta bg-ink px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-inkSoft disabled:opacity-40"
        >
          {asking ? "Asking…" : "Ask"}
          {!asking && <NextChevron />}
        </button>
      </div>

      <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
        <span className="font-semibold text-inkSoft">Ask</span> gives you a synthesized answer with its sources. To
        browse or fix specific facts, <span className="font-semibold text-inkSoft">search</span> the timeline below.
      </p>

      {state.kind === "error" && (
        <div className="mt-3 rounded-xl border border-coral/40 bg-coral/5 p-3 text-[13px] text-coral">
          {state.message}
        </div>
      )}

      {state.kind === "results" && state.hits.length === 0 && (
        <div className="mt-3 rounded-xl border border-ink/10 bg-bone/40 px-4 py-3 text-[13px] text-ink">
          Your brain has nothing on this yet.
        </div>
      )}

      {state.kind === "results" && state.hits.length > 0 && (
        <div className="mt-4 rounded-2xl border border-ink/10 bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.03)]">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="font-display text-[14px] font-bold tracking-tight text-ink">Search Result</h3>
            <span className="text-[12px] text-inkMuted">
              {state.hits.length} recalled · what your agents see
            </span>
          </div>
          <div className="space-y-2">
            {state.hits.map((h, i) => {
              const you = h.trust_tier === 0;
              const ch = channelLabel(h.source);
              const ChIcon = CHANNEL_ICON[ch];
              const time = timeLabel(h.created_at);
              return (
                <Link
                  key={`${h.chunk_id}-${i}`}
                  href={`/memory/${h.note_id}`}
                  className="group block w-full rounded-xl border border-ink/10 bg-white px-4 py-3 text-left transition-colors hover:bg-bone/30"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-[7px] block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[16px] font-semibold leading-[1.35] text-ink">
                          {h.title?.replace(/\.md$/, "") || "(untitled note)"}
                        </div>
                        {time && (
                          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-inkMuted">{time}</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-[1.55] text-inkMuted">
                        {(h.body ?? "").replace(/^#+\s*/gm, "").trim().slice(0, 200)}
                      </p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                        {you ? (
                          <Badge icon={User} label="You" iconClass="text-[#167f50]" />
                        ) : (
                          <>
                            <Badge icon={Zap} label="Auto" />
                            {ch !== "Agent run" && ch !== "Memory" && (
                              <>
                                <span aria-hidden className="text-ink/20">
                                  ·
                                </span>
                                <Badge icon={ChIcon ?? Zap} label={ch} />
                              </>
                            )}
                          </>
                        )}
                        {h.agent_slug && (
                          <>
                            <span aria-hidden className="text-ink/20">
                              ·
                            </span>
                            <Badge icon={Play} label="Agent Run" iconClass="text-[#167f50]" />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function errorCopy(status: number, code?: string): string {
  if (code === "bad_query" || status === 400) {
    return "Type a question first.";
  }
  if (code === "too_long" || status === 413) {
    return "That question is too long. Try a shorter one.";
  }
  if (status === 401) {
    return "Your session expired. Refresh the page and sign in again.";
  }
  return "The brain couldn't answer that right now. Try again in a moment.";
}
