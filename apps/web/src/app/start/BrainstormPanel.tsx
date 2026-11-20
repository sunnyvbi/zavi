"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/api";
import { ZaviMascot } from "@/components/ZaviMascot";
import {
  makeClamp,
  useResizablePane,
  type ClampSpec,
  type UseResizablePaneOptions,
} from "@/hooks/useResizablePane";
import { NextChevron } from "@/components/ui/NextChevron";

const BRAINSTORM_CLAMP: ClampSpec = { min: 400, maxFraction: 0.85, round: "result" };

const clampW = makeClamp(BRAINSTORM_CLAMP);

export const BRAINSTORM_PANE_OPTIONS: UseResizablePaneOptions = {
  ...BRAINSTORM_CLAMP,
  defaultFn: (vw) => vw * 0.4,
  initialSizePx: null,
  rehydrate: false,
  reclampOnResize: false,
  setBodyCursor: false,
  trackDragging: false,
  permanentListeners: true,
  resetTo: (current, vw) => {
    const narrow = clampW(vw * 0.4, vw);
    const wide = clampW(vw * 0.7, vw);
    return current !== null && current >= (narrow + wide) / 2 ? narrow : wide;
  },
  resetOnDoubleClick: false,
  ariaLabel: "Drag to resize",
};

type Role = "agent" | "user";
type Msg = { role: Role; text: string; options?: string[]; recommended?: string };

type Competitor = { name: string; angle: string };
type Landscape = {
  competitors?: Competitor[];
  market?: string;
  pricing?: string;
  gap?: string;
  wedge?: string;
  v1?: string;
  sources?: { title: string; url: string }[];
  grounded?: boolean;
  opening_message?: string;
};

const RESEARCH_STEPS = [
  "Scanning competitors…",
  "Reading the market…",
  "Mapping pricing models…",
  "Finding the gap…",
  "Pulling it together…",
];

type Props = {
  open: boolean;
  onClose: () => void;
  seedIdea: string;
  onUseIdea: (brief: string) => void;
};

const MAX_TURNS = 20;

function LandscapeRow({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div
      className={[
        "rounded-xl px-3 py-2",
        accent ? "bg-[#fdf3e9]" : "bg-cream/70",
      ].join(" ")}
    >
      <p
        className={[
          "text-[11px] font-semibold uppercase tracking-[0.06em]",
          accent ? "text-[#c47a2e]" : "text-inkMuted",
        ].join(" ")}
      >
        {label}
      </p>
      <p className="mt-0.5 text-[13px] leading-[1.45] text-ink">{text}</p>
    </div>
  );
}

export function BrainstormPanel({ open, onClose, seedIdea, onUseIdea }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [done, setDone] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [landscape, setLandscape] = useState<Landscape | null>(null);
  const [researching, setResearching] = useState(false);
  const [researchStep, setResearchStep] = useState(0);
  const [isDesktop, setIsDesktop] = useState(false);
  const {
    sizePx: panelW,
    resetSize: toggleWide,
    separatorProps,
  } = useResizablePane(BRAINSTORM_PANE_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const msgsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!researching) {
      setResearchStep(0);
      return;
    }
    const id = setInterval(
      () => setResearchStep((s) => Math.min(s + 1, RESEARCH_STEPS.length - 1)),
      4200,
    );
    return () => clearInterval(id);
  }, [researching]);

  const landscapeForReq = landscape
    ? {
        competitors: landscape.competitors,
        market: landscape.market,
        pricing: landscape.pricing,
        gap: landscape.gap,
        wedge: landscape.wedge,
        v1: landscape.v1,
      }
    : undefined;

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const isWideNow = panelW !== null && panelW >= window.innerWidth * 0.55;

  const userTurns = messages.filter((m) => m.role === "user").length;

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = msgsRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const fetchNext = useCallback(
    async (history: Msg[]) => {
      const isOpening = history.length === 0;
      setThinking(true);
      setError(null);
      let ok = false;
      try {
        const res = await fetch(apiUrl("/api/onboarding/brainstorm"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seedIdea,
            mode: "chat",
            landscape: landscapeForReq,
            history: history.map((m) => ({ role: m.role, text: m.text })),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          setError(data?.error?.message ?? "Brainstorm hit a snag. Try again.");
          return;
        }
        ok = true;
        setMessages((prev) => [
          ...prev,
          { role: "agent", text: data.message, options: data.options, recommended: data.recommended },
        ]);
        if (data.done) setDone(true);
      } catch {
        setError("Network hiccup. Try again.");
      } finally {
        setThinking(false);
        if (isOpening && !ok) startedRef.current = false;
        scrollDown();
      }
    },
    [seedIdea, landscapeForReq, scrollDown],
  );

  const runResearch = useCallback(async () => {
    setResearching(true);
    setError(null);
    let ok = false;
    try {
      const res = await fetch(apiUrl("/api/onboarding/brainstorm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedIdea, mode: "research" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.error?.message ?? "Research hit a snag. Try again.");
        return;
      }
      ok = true;
      setLandscape((data.landscape as Landscape) ?? null);
      setMessages([{ role: "agent", text: data.message }]);
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setResearching(false);
      if (!ok) startedRef.current = false;
      scrollDown();
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [seedIdea, scrollDown]);

  const retry = useCallback(() => {
    if (!landscape && messages.length === 0) void runResearch();
    else void fetchNext(messages);
  }, [landscape, messages, runResearch, fetchNext]);

  useEffect(() => {
    if (open && !startedRef.current && messages.length === 0 && !researching) {
      startedRef.current = true;
      if (seedIdea.trim().length >= 8) void runResearch();
      else void fetchNext([]);
    }
    if (open) setTimeout(() => inputRef.current?.focus(), 420);
  }, [open, runResearch, fetchNext, seedIdea, messages.length, researching]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || thinking || done || userTurns >= MAX_TURNS) return;
      const next: Msg[] = [...messages, { role: "user", text: t }];
      setMessages(next);
      setInput("");
      void fetchNext(next);
      scrollDown();
    },
    [messages, thinking, done, userTurns, fetchNext, scrollDown],
  );

  const useThisIdea = useCallback(async () => {
    if (summarizing || thinking) return;
    setSummarizing(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/onboarding/brainstorm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seedIdea,
          mode: "summarize",
          landscape: landscapeForReq,
          history: messages.map((m) => ({ role: m.role, text: m.text, options: m.options })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.brief) {
        setError(data?.error?.message ?? "Couldn't pull that together. Try again.");
        return;
      }
      onUseIdea(String(data.brief).trim());
      onClose();
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setSummarizing(false);
    }
  }, [summarizing, thinking, seedIdea, landscapeForReq, messages, onUseIdea, onClose]);

  const canUseIdea = userTurns >= 2 || done || (!!landscape && messages.length > 0);
  const hasLandscape =
    !!landscape &&
    ((landscape.competitors?.length ?? 0) > 0 ||
      !!landscape.wedge ||
      !!landscape.market ||
      !!landscape.gap ||
      !!landscape.v1);

  if (!mounted) return null;

  return createPortal(
    <>
      <style>{`
        @keyframes bsRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .bs-rise{animation:bsRise .34s cubic-bezier(.22,.61,.36,1) both}
        @media (prefers-reduced-motion:reduce){.bs-rise{animation:none}}
      `}</style>
      {}
      <div
        aria-hidden
        onClick={onClose}
        className={[
          "fixed inset-0 z-40 bg-black/20 transition-opacity duration-300 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      />
      <aside
        aria-label="Brainstorm your idea"
        aria-hidden={!open}
        style={isDesktop && panelW ? { width: panelW } : undefined}
        className={[
          "fixed right-0 top-0 z-50 flex h-full flex-col border-l border-[#e7e5e0] bg-white",
          "shadow-[-24px_0_60px_-30px_rgba(30,25,15,0.25)]",
          "transition-transform duration-[420ms] ease-[cubic-bezier(.22,.61,.36,1)]",
          "w-full",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {}
        {isDesktop && (
          <div
            {...separatorProps}
            className="group absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize"
          >
            <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-ink/20" />
          </div>
        )}
        {}
        <header className="flex items-start gap-3 border-b border-[#f0f0f0] px-4 pb-4 pt-5">
          <ZaviMascot size={34} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-bold leading-tight tracking-[-0.01em] text-ink">
              Brainstorm your idea
            </h2>
            <p className="mt-1 text-[13px] leading-[1.45] text-inkMuted">
              Think it through with Zavi, then drop it in the box and build.
            </p>
          </div>
          <div className="flex flex-none flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <button
                id="expandBtn"
                type="button"
                onClick={toggleWide}
                aria-label={isWideNow ? "Shrink panel" : "Widen panel"}
                title={isWideNow ? "Shrink" : "Widen"}
                className="hidden h-[30px] w-[30px] items-center justify-center rounded-full text-[13px] text-inkMuted transition-colors hover:bg-cream hover:text-ink lg:flex"
              >
                {isWideNow ? "⇥" : "⇤"}
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-[14px] leading-none text-inkMuted transition-colors hover:bg-cream hover:text-ink"
              >
                ✕
              </button>
            </div>
            <span className="whitespace-nowrap rounded-full bg-cream px-2 py-[3px] text-[11px] font-semibold tabular-nums text-inkMuted">
              {userTurns} / {MAX_TURNS}
            </span>
          </div>
        </header>

        {}
        <div ref={msgsRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-end gap-4 px-4 py-4">
            {}
            {researching && (
              <div className="bs-rise my-auto flex flex-col items-center gap-4 py-10 text-center">
                <ZaviMascot size={48} working />
                <div>
                  <p className="text-[14px] font-semibold text-ink">Researching your idea…</p>
                  <p className="mt-1 text-[13px] text-inkMuted">{RESEARCH_STEPS[researchStep]}</p>
                </div>
                <div className="flex gap-2">
                  {RESEARCH_STEPS.map((_, i) => (
                    <span
                      key={i}
                      className={[
                        "h-1.5 w-1.5 rounded-full transition-colors",
                        i <= researchStep ? "bg-[#e08c3e]" : "bg-[#e7e5e0]",
                      ].join(" ")}
                    />
                  ))}
                </div>
              </div>
            )}

            {}
            {hasLandscape && !researching && (
              <div className="bs-rise rounded-2xl border border-[#efeae4] bg-[linear-gradient(180deg,#ffffff,rgba(247,246,243,0.6))] p-4 shadow-[0_1px_2px_rgba(30,25,15,0.05),0_10px_28px_-16px_rgba(30,25,15,0.25)]">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.08em] text-ink">
                    <span aria-hidden className="text-[#e08c3e]">✦</span> Market landscape
                  </span>
                  <span className="rounded-full bg-cream px-2 py-[3px] text-[11px] font-semibold text-inkMuted">
                    {landscape?.grounded ? "web-researched" : "quick read"}
                  </span>
                </div>

                {landscape?.market && (
                  <p className="mb-3 text-[13px] leading-[1.5] text-inkMuted">{landscape.market}</p>
                )}

                {(landscape?.competitors?.length ?? 0) > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">
                      Who's already here
                    </p>
                    <ul className="flex flex-col gap-1">
                      {landscape!.competitors!.slice(0, 6).map((c, i) => (
                        <li key={i} className="text-[13px] leading-[1.45] text-ink">
                          <span className="font-semibold">{c.name}</span>
                          {c.angle ? <span className="text-inkMuted">: {c.angle}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {landscape?.gap && (
                    <LandscapeRow label="The gap" text={landscape.gap} />
                  )}
                  {landscape?.wedge && (
                    <LandscapeRow label="Sharpest wedge" text={landscape.wedge} accent />
                  )}
                  {landscape?.v1 && <LandscapeRow label="Smallest v1" text={landscape.v1} />}
                </div>

                {(landscape?.sources?.length ?? 0) > 0 && (
                  <p className="mt-3 text-[11px] text-inkMuted">
                    Based on {landscape!.sources!.length} live source
                    {landscape!.sources!.length === 1 ? "" : "s"}.
                  </p>
                )}
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="bs-rise flex justify-end">
                  <div className="max-w-[84%] rounded-2xl rounded-tr-md bg-ink px-3.5 py-2.5 text-[16px] leading-[1.5] text-white shadow-[0_2px_10px_-4px_rgba(25,25,25,0.4)]">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="bs-rise flex items-start gap-2.5">
                  <ZaviMascot size={26} className="mt-0.5" />
                  <div className="min-w-0">
                    <div className="max-w-full rounded-2xl rounded-tl-md border border-[#efeae4] bg-white px-3.5 py-2.5 text-[16px] leading-[1.55] text-ink shadow-[0_1px_2px_rgba(30,25,15,0.05),0_8px_24px_-14px_rgba(30,25,15,0.22)]">
                      {m.text}
                    </div>
                    {m.options && m.options.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {m.options.map((opt) => {
                          const suggested = m.recommended === opt;
                          return (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => send(opt)}
                              disabled={thinking || done}
                              title={suggested ? "Suggested" : undefined}
                              className={[
                                "inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium leading-[1.2] transition-all duration-150",
                                "hover:-translate-y-px active:translate-y-0 disabled:cursor-default disabled:opacity-50 disabled:hover:translate-y-0",
                                suggested
                                  ? "border border-[#f1c99e] bg-[#fdf3e9] text-ink shadow-[0_1px_2px_rgba(242,153,74,0.15)] hover:border-[#e9a869] hover:shadow-[0_3px_10px_-3px_rgba(242,153,74,0.4)]"
                                  : "border border-[#e7e5e0] bg-white text-ink shadow-[0_1px_2px_rgba(30,25,15,0.04)] hover:border-ink/60 hover:shadow-[0_3px_10px_-3px_rgba(30,25,15,0.18)]",
                              ].join(" ")}
                            >
                              {suggested && <span aria-hidden className="text-[#e08c3e]">✦</span>}
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
            {thinking && (
              <div className="bs-rise flex items-start gap-2.5">
                <ZaviMascot size={26} className="mt-0.5" working />
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-md border border-[#efeae4] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(30,25,15,0.05)]">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#c9c3ba] [animation-delay:-0.2s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#c9c3ba] [animation-delay:-0.1s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#c9c3ba]" />
                </div>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2.5 self-start rounded-xl bg-[#fdeeeb] px-3 py-2">
                <p className="text-[13px] text-[#b4402f]">{error}</p>
                <button
                  type="button"
                  onClick={retry}
                  disabled={thinking || researching}
                  className="rounded-full bg-white px-2.5 py-1 text-[12px] font-semibold text-ink shadow-sm hover:bg-cream disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>

        {}
        {canUseIdea && (
          <div className="mx-auto w-full max-w-[760px] px-4 pb-1">
            <button
              type="button"
              onClick={useThisIdea}
              disabled={summarizing || thinking || researching}
              className={[
                "flex w-full items-center justify-center gap-2 rounded-cta px-4 py-3 text-[16px] font-semibold transition-all",
                done
                  ? "bg-ink text-white shadow-[0_4px_14px_-4px_rgba(25,25,25,0.5)] hover:bg-inkSoft"
                  : "border border-ink/15 bg-cream text-ink hover:border-ink/30 hover:bg-[#f2f0eb]",
                summarizing ? "opacity-70" : "",
              ].join(" ")}
            >
              {summarizing ? "Pulling it together…" : <>Use this idea <NextChevron /></>}
            </button>
          </div>
        )}

        {}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="mx-auto w-full max-w-[760px] px-4 pb-4 pt-2.5"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-[#e7e5e0] bg-white px-2.5 py-2 shadow-[0_1px_3px_rgba(30,25,15,0.04)] transition-colors focus-within:border-ink/35 focus-within:shadow-[0_2px_10px_-4px_rgba(30,25,15,0.15)]">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              disabled={done || researching || userTurns >= MAX_TURNS}
              placeholder={done ? "That's plenty. Drop it in the box." : "Reply, or tap a suggestion…"}
              aria-label="Reply to Zavi"
              className="max-h-[120px] min-h-[34px] flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 text-[16px] leading-[1.45] text-ink placeholder:text-[#bfbfbf] focus:outline-none focus:ring-0 disabled:opacity-60"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={!input.trim() || thinking || done || researching}
              className="grid h-8 w-8 flex-none place-items-center rounded-full bg-ink text-[14px] text-white transition-all hover:bg-inkSoft disabled:opacity-30"
            >
              ↑
            </button>
          </div>
        </form>
      </aside>
    </>,
    document.body,
  );
}
