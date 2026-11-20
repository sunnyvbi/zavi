"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Clapperboard, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  ALL_STARTERS,
  STARTER_GROUPS,
  toolLoginHref,
  toolUseHref,
  type Starter,
} from "@/lib/workspace/starters";
import { stageComposerSeed } from "@/lib/workspace/composerSeed";
import { workspaceAgentHref } from "@/lib/workspace/tabUrl";
import { trackEvent } from "@/lib/analytics/events";

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

const INK = "text-[#0e0f11]";
const MUTED = "text-[#595959]";
const SUBTLE_BG = "bg-[#f9f9f9]";
const WRAP = "mx-auto w-full max-w-[1180px] px-3 sm:px-6";
const EYEBROW = `text-[14px] font-semibold uppercase tracking-[0.12em] ${MUTED}`;
const LABEL = `text-[12px] font-semibold uppercase tracking-[0.12em] ${MUTED}`;
const H2 = `text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.12] tracking-[-0.02em] ${INK}`;
const H3 = `text-[20px] font-bold leading-snug tracking-[-0.01em] ${INK}`;
const LEAD = `mx-auto mt-5 max-w-[60ch] text-[16px] leading-relaxed ${MUTED}`;
const CARD =
  "row-span-4 grid gap-0 rounded-block border border-black/[0.08] bg-white p-7 shadow-[0_1px_2px_rgba(16,18,20,0.04)]";
const TEXT_LINK = `inline-flex items-center gap-2 text-[14px] font-semibold ${INK} transition-opacity duration-200 hover:opacity-60`;
const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full bg-[#0e0f11] font-semibold text-white transition-opacity duration-200 hover:opacity-90";

const COMING_NEXT = [
  { title: "What search sees on your site", body: "A ranked fix pack plus paste-ready titles" },
  { title: "The page your site is missing", body: "A first draft of the page you do not have" },
  { title: "What AI answers say about you", body: "Which assistants mention you, and what they say" },
  { title: "A Reddit thread worth answering", body: "A real thread plus a reply written in your voice" },
  { title: "Your YouTube back catalogue, read", body: "Which videos earn attention and what to make next" },
];

function SectionHead({ eyebrow, title, lead }: { eyebrow?: string; title: string; lead?: string }) {
  return (
    <div className="mx-auto max-w-[760px] text-center">
      {eyebrow ? <p className={EYEBROW}>{eyebrow}</p> : null}
      <h2 className={`${H2} ${eyebrow ? "mt-4" : ""}`}>{title}</h2>
      {lead ? <p className={LEAD}>{lead}</p> : null}
    </div>
  );
}

export function ToolsClient({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [onlyNoConnect, setOnlyNoConnect] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setPendingId(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/playbooks");
        if (!res.ok) return;
        const data = (await res.json()) as { playbooks?: Playbook[] };
        if (!cancelled) setPlaybooks(Array.isArray(data.playbooks) ? data.playbooks : []);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const open = useCallback(
    (s: Starter) => {
      stageComposerSeed(s.agent, s.prompt);
      router.push(workspaceAgentHref(s.agent));
    },
    [router],
  );

  useEffect(() => {
    if (!signedIn) return;
    const id = new URLSearchParams(window.location.search).get("use");
    const s = id ? ALL_STARTERS.find((x) => x.id === id) : undefined;
    if (!s) return;
    stageComposerSeed(s.agent, s.prompt);
    router.replace(workspaceAgentHref(s.agent));
  }, [router, signedIn]);

  const onTry = (e: MouseEvent<HTMLAnchorElement>, s: Starter) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (pendingId) return;
    trackEvent("tool_try_clicked", { tool_id: s.id, agent: s.agent, signed_in: signedIn });
    setPendingId(s.id);
    if (signedIn) {
      open(s);
      return;
    }
    window.location.assign(toolLoginHref(s.id));
  };

  const total = ALL_STARTERS.length;
  const noConnect = ALL_STARTERS.filter((s) => !s.needsConnection).length;

  const groups = useMemo(
    () =>
      STARTER_GROUPS.map((g) => ({
        ...g,
        starters: onlyNoConnect ? g.starters.filter((s) => !s.needsConnection) : g.starters,
      })).filter((g) => g.starters.length > 0),
    [onlyNoConnect],
  );

  let band = 0;
  const nextBg = () => (band++ % 2 === 0 ? SUBTLE_BG : "bg-white");

  return (
    <>
      <section className="w-full pb-16">
        <div className={WRAP}>
          <div className="mx-auto max-w-[760px] text-center">
            <p className={EYEBROW}>Tools</p>
            <h1 className={`mt-4 text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.12] tracking-[-0.02em] ${INK}`}>
              Everything Zavi can make for you
            </h1>
            <p className={LEAD}>
              Ask in a sentence and a finished thing comes back. A deck, a report, a
              spreadsheet, a post image, a working prototype.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#f5faf8] px-4 py-2 text-[14px] font-semibold text-[#167f50]">
              <Check aria-hidden="true" strokeWidth={2.5} className="size-4" />
              {noConnect} of {total} need nothing connected
            </span>
            <button
              type="button"
              aria-pressed={onlyNoConnect}
              onClick={() => setOnlyNoConnect((v) => !v)}
              className={`inline-flex items-center rounded-full border px-4 py-2 text-[14px] font-semibold transition-opacity duration-200 hover:opacity-70 ${
                onlyNoConnect
                  ? "border-[#0e0f11] bg-[#0e0f11] text-white"
                  : `border-black/[0.08] bg-white ${MUTED}`
              }`}
            >
              {onlyNoConnect ? "Show all" : "Show only those"}
            </button>
          </div>
        </div>
      </section>

      <section className="w-full pb-16">
        <div className={WRAP}>
          <div className={`mx-auto max-w-[900px] rounded-blockLg ${SUBTLE_BG} px-6 py-14 text-center sm:px-12`}>
            <p className="inline-flex items-center gap-2 rounded-full bg-[#e6f2ff] px-4 py-2 text-[13px] font-semibold text-[#027bff]">
              <Clapperboard aria-hidden="true" strokeWidth={2.5} className="size-4" />
              No account needed at all
            </p>
            <h2 className={`mt-5 text-[clamp(1.75rem,3.6vw,2.5rem)] font-bold leading-[1.12] tracking-[-0.02em] ${INK}`}>
              A launch video for your product
            </h2>
            <p className={`mx-auto mt-5 max-w-[56ch] text-[16px] leading-relaxed ${MUTED}`}>
              Tell Zavi what you are launching and who it is for. It writes the script,
              designs it and renders the video. You give an email address, not an account.
            </p>
            <Link href="/launch-video" className={`${PRIMARY_BTN} mt-8 h-12 px-7 text-[16px]`}>
              Make a launch video
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <p className={`mt-4 text-[14px] ${MUTED}`}>No sign-up, no card, nothing to connect.</p>
          </div>
        </div>
      </section>

      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`tools-${group.id}`} className={`w-full py-16 lg:py-20 ${nextBg()}`}>
          <div className={WRAP}>
            <div className="mx-auto max-w-[760px] text-center">
              <p className={EYEBROW}>{group.title}</p>
              <h2 id={`tools-${group.id}`} className={`${H2} mt-4`}>
                {group.blurb}
              </h2>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {group.starters.map((s) => (
                <article key={s.id} className={CARD} style={{ gridTemplateRows: "subgrid" }}>
                  <h3 className={H3}>{s.title}</h3>
                  <p className={`mt-3 text-[14px] leading-relaxed ${MUTED}`}>{s.produces}</p>
                  <div className="mt-5">
                    <p className={LABEL}>Needs</p>
                    <p className={`mt-1.5 text-[14px] leading-relaxed ${INK}`}>{s.needs}</p>
                  </div>
                  <div className="mt-6 flex items-end">
                    <a
                      href={signedIn ? toolUseHref(s.id) : toolLoginHref(s.id)}
                      onClick={(e) => onTry(e, s)}
                      aria-disabled={pendingId !== null || undefined}
                      aria-busy={pendingId === s.id || undefined}
                      className={`${TEXT_LINK} ${
                        pendingId === null
                          ? ""
                          : pendingId === s.id
                            ? "pointer-events-none cursor-wait"
                            : "pointer-events-none opacity-40"
                      }`}
                    >
                      {pendingId === s.id ? (
                        <>
                          Opening…
                          <Loader2 aria-hidden="true" strokeWidth={2.5} className="size-4 animate-spin" />
                        </>
                      ) : (
                        <>
                          Try this
                          <ArrowRight aria-hidden="true" strokeWidth={2.5} className="size-4" />
                        </>
                      )}
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      ))}

      {playbooks.length > 0 && (
        <section aria-labelledby="tools-playbooks" className={`w-full py-16 lg:py-20 ${nextBg()}`}>
          <div className={WRAP}>
            <div className="mx-auto max-w-[760px] text-center">
              <p className={EYEBROW}>Run a whole play</p>
              <h2 id="tools-playbooks" className={`${H2} mt-4`}>
                Bigger jobs your team runs end to end.
              </h2>
              <p className={LEAD}>Nothing happens to your data, ads or customers until you approve it.</p>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {playbooks.map((p) => (
                <article
                  key={p.slug}
                  className="flex flex-col rounded-block border border-black/[0.08] bg-white p-7 shadow-[0_1px_2px_rgba(16,18,20,0.04)]"
                >
                  <p className={LABEL}>~{p.est_credits.toLocaleString()} credits</p>
                  <h3 className={`mt-3 ${H3}`}>{p.title}</h3>
                  <p className={`mt-3 text-[14px] leading-relaxed ${MUTED}`}>{p.outcome}</p>
                  {[
                    ["You get", p.produces],
                    ["It reads", p.data_used],
                    ["You approve", p.needs_approval],
                  ].map(([label, items]) => (
                    <div key={label as string} className="mt-5">
                      <p className={LABEL}>{label as string}</p>
                      <p className={`mt-1.5 text-[14px] leading-relaxed ${INK}`}>{(items as string[]).join("; ")}</p>
                    </div>
                  ))}
                  <div className="mt-auto flex items-end pt-6">
                    <Link href="/playbooks" className={TEXT_LINK}>
                      Open in Playbooks
                      <ArrowRight aria-hidden="true" strokeWidth={2.5} className="size-4" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className={`w-full ${SUBTLE_BG} py-16 lg:py-20`}>
        <div className={WRAP}>
          <SectionHead
            eyebrow="Coming next"
            title="The growth tools are not here yet"
            lead="Everything above makes you a document, a deck or an image. None of it does the growth work, which is the part Zavi is for. These five each run on something that already exists, so they are the next entries rather than a wish list."
          />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {COMING_NEXT.map((c) => (
              <div key={c.title} className="rounded-block border border-dashed border-black/[0.18] bg-white/60 p-7 text-center">
                <p className={LABEL}>Not built yet</p>
                <h3 className={`mt-3 ${H3}`}>{c.title}</h3>
                <p className={`mt-3 text-[14px] leading-relaxed ${MUTED}`}>{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="w-full bg-white py-20 lg:py-24">
        <div className={WRAP}>
          <SectionHead
            title="Run any of these on your business"
            lead="Give Zavi your website and it reads what is public. Nothing to install."
          />
          <div className="text-center">
            <Link href={signedIn ? "/workspace" : "/start"} className={`${PRIMARY_BTN} mt-9 px-8 py-4 text-[16px]`}>
              {signedIn ? "Open Zavi" : "Try it on your business"}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <p className={`mt-4 text-[14px] ${MUTED}`}>Free to start. No card, no sales call.</p>
          </div>
        </div>
      </section>
    </>
  );
}
