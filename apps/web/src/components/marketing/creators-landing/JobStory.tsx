"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Briefcase, Check, CircleDollarSign, FileVideo, Lock, MessageSquare, RotateCcw, UserRound, Wallet } from "lucide-react";
import { CHANNEL_PAGES, ChannelGlyph } from "@/components/marketing/growth-home/channels/channelPages";
import { businessTotal, creatorGets, FEES, money, REVISION_ROUNDS } from "./fees";
import { ExampleTag } from "./shared";

const PRICE = 150;
const TIKTOK = CHANNEL_PAGES.find((c) => c.id === "tiktok")!;
const PAYS = money(businessTotal(PRICE));
const GETS = money(creatorGets(PRICE));

type Step = { title: string; body: string; note?: string };

const STEPS: Step[] = [
  {
    title: "A business books you",
    body: `Acme Coffee books your ${money(PRICE)} TikTok video package. Its card is held for ${PAYS}: your price plus ${FEES.businessPct}%.`,
    note: "Businesses can also send you a custom offer, or you can apply to a brief they post.",
  },
  {
    title: "You accept, the card is charged",
    body: "Accept the job and the hold becomes a charge. The money is in place before you start work.",
  },
  {
    title: "You deliver in Zavi",
    body: `Send the video in Zavi. Every order includes ${REVISION_ROUNDS} rounds of changes. If the business wants more after that, Zavi steps in.`,
  },
  {
    title: "Approved, you get paid",
    body: `When the business approves, you receive ${GETS} through Stripe. You add payout details at this first job, not before.`,
  },
];

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-[#595959]">{label}</span>
      <span className={`tabular-nums text-[#0e0f11] ${strong ? "font-bold" : "font-medium"}`}>{value}</span>
    </div>
  );
}

function JobHeader({ status, tone }: { status: string; tone: "dark" | "violet" | "amber" | "green" }) {
  const chip = {
    dark: "bg-[#0e0f11] text-white",
    violet: "bg-[#9b5de5]/12 text-[#7a3fc4]",
    amber: "bg-[#d99a00]/14 text-[#946300]",
    green: "bg-[#f5faf8] text-[#167f50]",
  }[tone];
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#8a5a3b] text-[13px] font-bold text-white">AC</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-[#0e0f11]">Acme Coffee</p>
        <p className="flex items-center gap-2 text-[12px] text-[#595959]">
          <ChannelGlyph channel={TIKTOK} className="size-3" /> 1 TikTok video
        </p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${chip}`}>{status}</span>
    </div>
  );
}

function StateBooked() {
  return (
    <>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-[#0e0f11]">
        <Bell className="size-4" /> New booking request
      </p>
      <div className="mt-3">
        <JobHeader status="New" tone="dark" />
      </div>
      <div className="mt-4 space-y-2 rounded-2xl bg-[#f9f9f9] p-3">
        <Row label="Your price" value={money(PRICE)} />
        <Row label="You receive" value={GETS} strong />
      </div>
      <p className="mt-3 flex items-center gap-2 text-[12px] text-[#595959]">
        <Lock className="size-3.5" /> Card held: {PAYS}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <span className="inline-flex h-10 items-center justify-center rounded-full border border-black/[0.1] text-[13px] font-semibold text-[#0e0f11]">Decline</span>
        <span className="inline-flex h-10 items-center justify-center rounded-full bg-[#0e0f11] text-[13px] font-semibold text-white">Accept</span>
      </div>
    </>
  );
}

function StateAccepted() {
  return (
    <>
      <JobHeader status="In progress" tone="violet" />
      <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-[#9b5de5]/25 bg-[#9b5de5]/[0.06] p-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-[#9b5de5] text-white">
          <Check className="size-4" strokeWidth={3} />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[#0e0f11]">You accepted</p>
          <p className="text-[12px] text-[#595959]">Card charged {PAYS}</p>
        </div>
      </div>
      <div className="mt-3 rounded-2xl bg-[#f9f9f9] p-3">
        <p className="text-[12px] font-semibold text-[#595959]">Brief</p>
        <p className="mt-1 text-[13px] leading-snug font-medium text-[#0e0f11]">Show our new cold brew on a busy morning.</p>
      </div>
      <span className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-full bg-[#0e0f11] text-[13px] font-semibold text-white">Upload your video</span>
    </>
  );
}

function StateDelivered() {
  return (
    <>
      <JobHeader status="In review" tone="amber" />
      <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-black/[0.07] p-3">
        <span className="flex size-9 items-center justify-center rounded-[10px] bg-[#f9f9f9] text-[#0e0f11]">
          <FileVideo className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[#0e0f11]">cold-brew-final.mp4</p>
          <p className="text-[12px] text-[#595959]">Delivered</p>
        </div>
        <Check className="size-4 text-[#167f50]" strokeWidth={3} />
      </div>
      <div className="mt-3 rounded-2xl bg-[#f9f9f9] p-3">
        <p className="flex items-center gap-2 text-[12px] font-semibold text-[#0e0f11]">
          <RotateCcw className="size-3.5" /> Rounds of changes
        </p>
        <div className="mt-2 flex gap-2">
          {Array.from({ length: REVISION_ROUNDS }, (_, k) => (
            <span key={k} className="h-1.5 flex-1 rounded-full bg-black/[0.12]" />
          ))}
        </div>
        <p className="mt-2 text-[12px] text-[#595959]">{REVISION_ROUNDS} included. After that, Zavi steps in.</p>
      </div>
      <p className="mt-4 text-center text-[12px] text-[#595959]">Waiting for Acme Coffee to approve</p>
    </>
  );
}

function StatePaid() {
  return (
    <>
      <JobHeader status="Paid" tone="green" />
      <div className="mt-5 rounded-[16px] bg-[#f5faf8] p-4 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-[#167f50] text-white">
          <Check className="size-5" strokeWidth={3} />
        </span>
        <p className="mt-2 text-[13px] font-semibold text-[#0e0f11]">Approved by Acme Coffee</p>
        <p className="mt-1 text-[12px] text-[#595959]">You receive</p>
        <p className="text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-[#0e0f11] tabular-nums">{GETS}</p>
      </div>
      <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-[#595959]">
        <CircleDollarSign className="size-3.5" /> Paid out through Stripe
      </p>
    </>
  );
}

const STATES: ReactNode[] = [<StateBooked key="b" />, <StateAccepted key="a" />, <StateDelivered key="d" />, <StatePaid key="p" />];

function StatusBar() {
  return (
    <div className="relative flex h-[46px] shrink-0 items-center justify-between px-6 pt-1.5 text-[#0e0f11]">
      <span className="text-[14px] font-semibold tabular-nums tracking-[-0.01em]">9:41</span>
      {}
      <span className="absolute top-[11px] left-1/2 h-[24px] w-[76px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-[5px]">
        <svg viewBox="0 0 17 11" className="h-[10px] w-[16px]" fill="currentColor">
          <rect x="0" y="7" width="3" height="4" rx="0.8" />
          <rect x="4.5" y="5" width="3" height="6" rx="0.8" />
          <rect x="9" y="2.5" width="3" height="8.5" rx="0.8" />
          <rect x="13.5" y="0" width="3" height="11" rx="0.8" />
        </svg>
        <svg viewBox="0 0 16 11" className="h-[10px] w-[15px]" fill="currentColor">
          <path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 .6 10 10 0 0 0 .9 3.5L2 4.6a8.4 8.4 0 0 1 6-2.4Z" />
          <path d="M8 5.4c1.4 0 2.7.5 3.7 1.4l1.1-1.1A6.9 6.9 0 0 0 8 3.8a6.9 6.9 0 0 0-4.8 1.9l1.1 1.1c1-.9 2.3-1.4 3.7-1.4Z" />
          <path d="M8 8.6c.6 0 1.1.2 1.5.6L8 10.7 6.5 9.2c.4-.4.9-.6 1.5-.6Z" />
        </svg>
        <span className="relative flex h-[11px] w-[23px] items-center rounded-[3.5px] border border-[#0e0f11]/40 p-[1.5px]">
          <span className="h-full w-[80%] rounded-[1.5px] bg-[#0e0f11]" />
          <span className="absolute top-1/2 -right-[3px] h-[4px] w-[1.5px] -translate-y-1/2 rounded-r-sm bg-[#0e0f11]/40" />
        </span>
      </span>
    </div>
  );
}

const TABS = [
  { Icon: Briefcase, label: "Jobs", on: true },
  { Icon: MessageSquare, label: "Messages", on: false },
  { Icon: Wallet, label: "Earnings", on: false },
  { Icon: UserRound, label: "Profile", on: false },
];

function Phone({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden="true" className={`relative mx-auto w-full max-w-[290px] ${className}`}>
      {}
      <span className="absolute top-[18%] -left-[2px] h-[26px] w-[3px] rounded-l-sm bg-[#3a3c40]" />
      <span className="absolute top-[26%] -left-[2px] h-[46px] w-[3px] rounded-l-sm bg-[#3a3c40]" />
      <span className="absolute top-[35%] -left-[2px] h-[46px] w-[3px] rounded-l-sm bg-[#3a3c40]" />
      <span className="absolute top-[28%] -right-[2px] h-[70px] w-[3px] rounded-r-sm bg-[#3a3c40]" />
      {}
      <div className="rounded-[50px] bg-[linear-gradient(145deg,#5b5e63_0%,#2a2c30_35%,#1a1b1e_65%,#4a4d52_100%)] p-[3px] shadow-[0_40px_80px_-30px_rgba(16,18,20,0.55),0_12px_24px_-12px_rgba(16,18,20,0.35)]">
        <div className="rounded-[47px] bg-black p-[9px]">
          <div className="relative flex aspect-[9/19.5] flex-col overflow-hidden rounded-[39px] bg-white">
            <StatusBar />
            <div className="flex items-center justify-between px-4 pt-1 pb-2">
              <span className="text-[20px] font-bold tracking-[-0.02em] text-[#0e0f11]">Your jobs</span>
              <ExampleTag />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-4 pt-2">{children}</div>
            <div className="shrink-0 border-t border-black/[0.06] bg-white/95 px-3 pt-2 pb-[22px]">
              <div className="grid grid-cols-4">
                {TABS.map(({ Icon, label, on }) => (
                  <span key={label} className={`flex flex-col items-center gap-0.5 text-[11px] font-medium ${on ? "text-[#0e0f11]" : "text-[#9a9a9a]"}`}>
                    <Icon className="size-[18px]" strokeWidth={on ? 2.4 : 2} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
            {}
            <span className="absolute bottom-[7px] left-1/2 h-[4px] w-[100px] -translate-x-1/2 rounded-full bg-[#0e0f11]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobStory() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const els = stepRefs.current.filter((e): e is HTMLLIElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section id="how" data-creator-job className="w-full scroll-mt-24 bg-[#f6f6f7] py-14 lg:py-16">
      <style>{`@keyframes jsIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      <div className="mx-auto max-w-[1080px] px-6 lg:px-10">
        <div className="mx-auto max-w-[680px] text-center">
          <p className="text-[14px] font-semibold tracking-[0.12em] text-[#595959] uppercase">How it works</p>
          <h2 className="mt-4 text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.1] font-bold tracking-[-0.02em] text-[#0e0f11]">
            A job, start to finish
          </h2>
        </div>

        <div className="mt-10 grid gap-12 lg:mt-10 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-20">
          {}
          <div className="hidden lg:block">
            <div className="sticky top-28">
              <Phone>
                <div key={active} className="[animation:jsIn_.45s_ease_both]">
                  {STATES[active]}
                </div>
              </Phone>
              <div className="mt-5 flex justify-center gap-2" aria-hidden="true">
                {STEPS.map((s, k) => (
                  <span key={s.title} className={`h-1.5 rounded-full transition-all duration-300 ${k === active ? "w-6 bg-[#0e0f11]" : "w-1.5 bg-black/20"}`} />
                ))}
              </div>
            </div>
          </div>

          <ol className="flex flex-col gap-12 lg:gap-0">
            {STEPS.map((s, k) => {
              const on = k === active;
              return (
                <li
                  key={s.title}
                  ref={(el) => {
                    stepRefs.current[k] = el;
                  }}
                  data-step={k}
                  className="flex flex-col items-center gap-6 lg:min-h-[196px] lg:items-start lg:justify-center"
                >
                  <div className={`w-full transition-opacity duration-300 lg:max-w-[440px] ${on ? "lg:opacity-100" : "lg:opacity-40"}`}>
                    <span className="flex size-9 items-center justify-center rounded-full bg-[#0e0f11] text-[14px] font-bold text-white tabular-nums">{k + 1}</span>
                    <h3 className="mt-4 text-[24px] leading-tight font-bold tracking-[-0.01em] text-[#0e0f11] sm:text-[28px]">{s.title}</h3>
                    <p className="mt-3 text-[16px] leading-relaxed text-[#595959]">{s.body}</p>
                    {s.note && <p className="mt-3 text-[14px] leading-relaxed text-[#595959]">{s.note}</p>}
                  </div>
                  {}
                  <Phone className="lg:hidden">{STATES[k]}</Phone>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
