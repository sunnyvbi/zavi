"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { PreviewFrame, ZaviAvatar } from "./PreviewFrame";

type Avatar = { initial: string; bg: string; fg: string };

type MetricRow = { label: string; value: string; delta: string; bad?: boolean };
type ChangeRow = { tag: "Pause" | "Add"; text: string; amount: string };
type RedditRow = { sub: string; meta: string; title: string; drafted?: boolean };
type ScheduleRow = { when: string; channel: string; title: string };
type PromptRow = { name: string; fill: number; marker: number; value: string; delta: string };
type CodeLine = { n: number; text: string; add?: boolean };

type Card =
  | { kind: "metrics"; title: string; rows: MetricRow[] }
  | { kind: "changes"; title: string; rows: ChangeRow[]; note: string }
  | { kind: "reddit"; title: string; rows: RedditRow[] }
  | { kind: "schedule"; title: string; rows: ScheduleRow[] }
  | { kind: "prompts"; title: string; meta: string; rows: PromptRow[] }
  | { kind: "code"; file: string; pr: string; lines: CodeLine[] };

type Thread = {
  name: string;
  channel: string;
  time: string;
  preview: string;
  chip: Avatar;
  asker: { name: string } & Avatar;
  answerTime: string;
  question: string;
  answer: string;
  bullets?: string[];
  card: Card;
  actions: [string, string];
  reactions: [string, number][];
};

const THREADS: Thread[] = [
  {
    name: "Results",
    channel: "results",
    time: "8:01 AM",
    preview: "Maya: Did anything move by more than 10% week over week?",
    chip: { initial: "R", bg: "#fde8dc", fg: "#b4541a" },
    asker: { name: "Maya Chen", initial: "M", bg: "#efe6fb", fg: "#6b3fb0" },
    answerTime: "8:02 AM",
    question: "did anything move by more than 10% week over week?",
    answer: "Four numbers moved past 10%. Three are good news. One needs a call from you.",
    card: {
      kind: "metrics",
      title: "Week over week · Sep 1–7",
      rows: [
        { label: "Bookings", value: "610", delta: "+18.2%" },
        { label: "Blended CAC", value: "$23", delta: "−12.4%" },
        { label: "Organic sessions", value: "8,420", delta: "+11.0%" },
        { label: "TikTok ad CTR", value: "0.9%", delta: "−14.1%", bad: true },
      ],
    },
    actions: ["Pause TikTok ad set", "Keep it running"],
    reactions: [
      ["🙌", 5],
      ["🔥", 1],
    ],
  },
  {
    name: "Paid Ads",
    channel: "paid-ads",
    time: "9:53 AM",
    preview: "Leo: Our Google Ads CAC jumped 40% yesterday. What happened?",
    chip: { initial: "P", bg: "#e3effd", fg: "#1d5fb8" },
    asker: { name: "Leo Park", initial: "L", bg: "#e3effd", fg: "#1d5fb8" },
    answerTime: "9:55 AM",
    question: "our Google Ads CAC jumped 40% yesterday. What happened?",
    answer:
      "Broad match on “car rental” spent $1,240 for 2 bookings. I drafted a budget move to fix it.",
    card: {
      kind: "changes",
      title: "Google Ads · proposed change",
      rows: [
        { tag: "Pause", text: "car rental · broad match", amount: "−$410/day" },
        { tag: "Add", text: "airport car rental · exact", amount: "+$290/day" },
        { tag: "Add", text: "one way car rental · phrase", amount: "+$120/day" },
      ],
      note: "Same daily budget. Expected CAC $31 → $24.",
    },
    actions: ["Approve", "Reject"],
    reactions: [["👀", 3]],
  },
  {
    name: "SEO",
    channel: "seo",
    time: "11:07 AM",
    preview: "Priya: The pricing page dropped off page one since Tuesday.",
    chip: { initial: "S", bg: "#e4f4e8", fg: "#2f6b3a" },
    asker: { name: "Priya Nair", initial: "P", bg: "#e4f4e8", fg: "#2f6b3a" },
    answerTime: "11:10 AM",
    question: "the pricing page dropped off page one since Tuesday.",
    answer: "Root cause: Tuesday's deploy pointed the canonical tag at staging.",
    bullets: [
      "Fix is up as PR #4830 (tests passing)",
      "Recrawl requested in Search Console",
      "Rank tracking set to hourly",
    ],
    card: {
      kind: "code",
      file: "app/pricing/layout.tsx",
      pr: "PR #4830",
      lines: [
        { n: 1, text: '- canonical: "https://staging.zavi.app/pricing",' },
        { n: 2, text: "+ canonical: `${SITE_URL}/pricing`,", add: true },
        { n: 3, text: "+ robots: { index: true, follow: true },", add: true },
      ],
    },
    actions: ["Merge PR", "Reject"],
    reactions: [
      ["🙌", 5],
      ["🔥", 1],
    ],
  },
  {
    name: "Content",
    channel: "content",
    time: "2:30 PM",
    preview: "Nina: Turn the new pricing guide into this week's posts.",
    chip: { initial: "C", bg: "#efe6fb", fg: "#6b3fb0" },
    asker: { name: "Nina Shah", initial: "N", bg: "#efe6fb", fg: "#6b3fb0" },
    answerTime: "2:34 PM",
    question: "turn the new pricing guide into this week's posts.",
    answer: "Four posts drafted in your brand voice. Nothing goes out until you approve.",
    card: {
      kind: "schedule",
      title: "Scheduled · this week",
      rows: [
        { when: "Tue 9:00 AM", channel: "LinkedIn", title: "What a $14k/mo growth team actually does" },
        { when: "Wed 12:00 PM", channel: "X thread", title: "7 pricing page mistakes we fixed" },
        { when: "Thu 6:00 PM", channel: "Instagram", title: "Carousel: CAC before and after" },
        { when: "Fri 8:00 AM", channel: "Newsletter", title: "The pricing guide in 5 minutes" },
      ],
    },
    actions: ["Approve all 4", "Edit drafts"],
    reactions: [["✍️", 2]],
  },
  {
    name: "Community",
    channel: "community",
    time: "1:12 PM",
    preview: "Raj: Is anyone on Reddit asking for tools like ours?",
    chip: { initial: "C", bg: "#fff1c9", fg: "#8a6200" },
    asker: { name: "Raj Mehta", initial: "R", bg: "#e3effd", fg: "#1d5fb8" },
    answerTime: "1:15 PM",
    question: "is anyone on Reddit asking for tools like ours?",
    answer: "6 new threads this week. 2 are worth a reply, and both replies are drafted.",
    card: {
      kind: "reddit",
      title: "Reddit · last 7 days",
      rows: [
        {
          sub: "r/startups",
          meta: "184 upvotes · 61 comments",
          title: "How do you grow a startup with no budget?",
          drafted: true,
        },
        {
          sub: "r/smallbusiness",
          meta: "92 upvotes · 40 comments",
          title: "Is an AI marketing agent actually worth it?",
          drafted: true,
        },
        { sub: "r/Entrepreneur", meta: "31 upvotes · 12 comments", title: "Agency or in-house for SEO?" },
      ],
    },
    actions: ["Post 2 replies", "Skip"],
    reactions: [["👍", 3]],
  },
  {
    name: "AI Search",
    channel: "ai-search",
    time: "8:41 AM",
    preview: "Sofia: Do we show up in ChatGPT answers yet?",
    chip: { initial: "A", bg: "#e0f3f4", fg: "#17707a" },
    asker: { name: "Sofia Reyes", initial: "S", bg: "#fde2e8", fg: "#b0264a" },
    answerTime: "8:43 AM",
    question: "do we show up in ChatGPT answers yet?",
    answer: "Yes. You now appear in 7 of 20 tracked prompts, up from 2 last month.",
    card: {
      kind: "prompts",
      title: "AI search visibility · 20 prompts",
      meta: "last month",
      rows: [
        { name: "ChatGPT", fill: 35, marker: 10, value: "7/20", delta: "+5" },
        { name: "Perplexity", fill: 25, marker: 5, value: "5/20", delta: "+4" },
        { name: "Gemini", fill: 15, marker: 0, value: "3/20", delta: "+3" },
      ],
    },
    actions: ["Draft 3 fixes", "See prompts"],
    reactions: [["🔥", 4]],
  },
];

const ROTATE_MS = 9000;
const TYPING_MS = 1400;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

function Initial({ a, size, radius }: { a: Avatar; size: number; radius: string }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    background: a.bg,
    color: a.fg,
    fontSize: Math.round(size * 0.44),
    borderRadius: radius,
  };
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center font-bold" style={style}>
      {a.initial}
    </span>
  );
}

function TypingDots() {
  return (
    <span role="status" aria-label="Zavi is typing" className="flex h-5 items-center gap-1">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="zavi-typing-dot h-1.5 w-1.5 rounded-full bg-[#9a9aa6]"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

const CARD_SHELL = "w-full max-w-[460px] overflow-hidden rounded-[12px] border border-[#e6e6ee] bg-white";
const CARD_HEAD = "flex items-center justify-between gap-3 border-b border-[#f1f1f5] px-3.5 py-2.5";
const CARD_TITLE = "truncate text-[13px] font-semibold leading-5 text-[#1a182b]";
const ROW = "flex items-center gap-3 px-3.5 py-2 text-[13px] leading-5";

function AnswerCard({ card }: { card: Card }) {
  if (card.kind === "metrics") {
    return (
      <div className={CARD_SHELL}>
        <div className={CARD_HEAD}>
          <p className={CARD_TITLE}>{card.title}</p>
        </div>
        <ul className="divide-y divide-[#f1f1f5]">
          {card.rows.map((r) => (
            <li key={r.label} className={ROW}>
              <span className="min-w-0 flex-1 truncate text-[#4b4b57]">{r.label}</span>
              <span className="font-semibold tabular-nums text-[#1a182b]">{r.value}</span>
              <span
                className={`w-[62px] rounded-full py-0.5 text-center text-[12px] font-semibold tabular-nums ${
                  r.bad ? "bg-[#fdecec] text-[#b42318]" : "bg-[#e9f7ee] text-[#1a7f37]"
                }`}
              >
                {r.delta}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (card.kind === "changes") {
    return (
      <div className={CARD_SHELL}>
        <div className={CARD_HEAD}>
          <p className={CARD_TITLE}>{card.title}</p>
        </div>
        <ul className="divide-y divide-[#f1f1f5]">
          {card.rows.map((r) => (
            <li key={r.text} className={ROW}>
              <span
                className={`w-[46px] shrink-0 rounded-[5px] py-0.5 text-center text-[11px] font-bold uppercase tracking-[0.04em] ${
                  r.tag === "Pause" ? "bg-[#fdecec] text-[#b42318]" : "bg-[#e9f7ee] text-[#1a7f37]"
                }`}
              >
                {r.tag}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#1a182b]">{r.text}</span>
              <span className="shrink-0 font-semibold tabular-nums text-[#1a182b]">{r.amount}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-[#f1f1f5] bg-[#f7f7fa] px-3.5 py-2 text-[13px] leading-5 text-[#4b4b57]">
          {card.note}
        </p>
      </div>
    );
  }

  if (card.kind === "reddit") {
    return (
      <div className={CARD_SHELL}>
        <div className={CARD_HEAD}>
          <p className={CARD_TITLE}>{card.title}</p>
        </div>
        <ul className="divide-y divide-[#f1f1f5]">
          {card.rows.map((r) => (
            <li key={r.title} className="flex flex-col gap-0.5 px-3.5 py-2">
              <p className="flex items-center gap-2 text-[12px] leading-5">
                <span className="font-semibold text-[#d93a00]">{r.sub}</span>
                <span className="truncate tabular-nums text-[#6b6b78]">{r.meta}</span>
                {r.drafted && (
                  <span className="ml-auto shrink-0 rounded-full bg-[#e8f1ff] px-2 text-[11px] font-semibold leading-5 text-[#027bff]">
                    Reply drafted
                  </span>
                )}
              </p>
              <p className="truncate text-[13px] leading-5 text-[#1a182b]">{r.title}</p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (card.kind === "schedule") {
    return (
      <div className={CARD_SHELL}>
        <div className={CARD_HEAD}>
          <p className={CARD_TITLE}>{card.title}</p>
        </div>
        <ul className="divide-y divide-[#f1f1f5]">
          {card.rows.map((r) => (
            <li key={r.title} className={ROW}>
              <span className="w-[88px] shrink-0 text-[12px] tabular-nums text-[#6b6b78]">{r.when}</span>
              <span className="shrink-0 rounded-full border border-[#e6e6ee] px-2 text-[12px] font-medium leading-5 text-[#4b4b57]">
                {r.channel}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#1a182b]">{r.title}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (card.kind === "prompts") {
    return (
      <div className={CARD_SHELL}>
        <div className={CARD_HEAD}>
          <p className={CARD_TITLE}>{card.title}</p>
          <span className="flex items-center gap-2 text-[12px] text-[#6b6b78]">
            <span aria-hidden="true" className="h-2.5 w-0.5 rounded-full bg-[#1a182b]/40" />
            {card.meta}
          </span>
        </div>
        <ul className="flex flex-col gap-2.5 px-3.5 py-3">
          {card.rows.map((r) => (
            <li key={r.name} className="flex items-center gap-3 text-[13px] leading-5">
              <span className="w-[74px] shrink-0 text-[#1a182b]">{r.name}</span>
              <span className="relative h-2 flex-1 rounded-full bg-[#efeff3]">
                <span className="absolute inset-y-0 left-0 rounded-full bg-[#027bff]" style={{ width: `${r.fill}%` }} />
                <span
                  aria-hidden="true"
                  className="absolute -bottom-0.5 -top-0.5 w-0.5 rounded-full bg-[#1a182b]/40"
                  style={{ left: `${r.marker}%` }}
                />
              </span>
              <span className="w-[42px] shrink-0 text-right font-semibold tabular-nums text-[#1a182b]">{r.value}</span>
              <span className="w-[26px] shrink-0 text-right text-[12px] font-semibold tabular-nums text-[#1a7f37]">
                {r.delta}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[460px]">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[13px] leading-5">
        <span className="text-[#1a182b]">Code change</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[#4b4b57]">{card.file}</span>
          <span className="shrink-0 rounded-[4px] bg-[#efeff3] px-1.5 py-0.5 text-[12px] text-[#4b4b57]">{card.pr}</span>
        </span>
      </div>
      <div className="overflow-x-auto rounded-[8px] border border-[#e6e6ee] font-mono text-[13px] leading-5">
        {card.lines.map((l) => (
          <div key={l.n} className={`flex min-w-max ${l.n > 1 ? "border-t border-[#efeff3]" : ""}`}>
            <span className="w-8 shrink-0 bg-white py-1.5 text-center tabular-nums text-[#6b6b78]">{l.n}</span>
            <code
              className={`flex-1 whitespace-pre px-3 py-1.5 ${
                l.add ? "bg-[#eefbf0] text-[#1a7f37]" : "bg-[#fdeeee] text-[#b42318]"
              }`}
            >
              {l.text}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

const WA_OUT = "#d9fdd3";
const WA_WALL = "#efeae2";
const WA_MUTED = "#667781";
const WA_LINK = "#027eb5";
const TG_BLUE = "#3390ec";
const TG_OUT = "#effdde";
const TG_MUTED = "#707579";

const SIDEBAR = "hidden w-[248px] shrink-0 flex-col sm:flex";

function DoubleCheck({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 18 12" aria-hidden="true" className="h-3 w-[18px] shrink-0" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.2 6.6 4.2 9.6 10.4 2.4" />
      <path d="M6.6 6.9 9 9.6 15.2 2.4" />
    </svg>
  );
}

function SearchPill({ tone }: { tone: "whatsapp" | "telegram" }) {
  const wa = tone === "whatsapp";
  return (
    <div className={`flex h-9 items-center gap-2.5 rounded-[8px] px-3 ${wa ? "bg-white" : "bg-[#f1f3f5]"}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0" fill="none" stroke={wa ? WA_MUTED : TG_MUTED} strokeWidth={2} strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.2-3.2" />
      </svg>
      <span className={`text-[14px] ${wa ? "text-[#667781]" : "text-[#707579]"}`}>
        {wa ? "Search or start new chat" : "Search"}
      </span>
    </div>
  );
}

function WaSidebar({ active, onPick }: { active: number; onPick: (i: number) => void }) {
  return (
    <aside aria-label="Chats" className={`${SIDEBAR} border-r border-[#e9edef] bg-white`}>
      <div className="flex h-[59px] shrink-0 items-center justify-between bg-[#f0f2f5] px-4">
        <span className="text-[20px] font-semibold text-[#111b21]">Chat</span>
        <span aria-hidden="true" className="flex items-center gap-4 text-[#54656f]">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <path d="M12 4v16M4 12h16" />
          </svg>
          <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </span>
      </div>
      <div className="shrink-0 bg-white px-3 py-2">
        <SearchPill tone="whatsapp" />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {THREADS.map((t, i) => (
          <li key={t.channel}>
            <button
              type="button"
              aria-current={i === active}
              onClick={() => onPick(i)}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                i === active ? "bg-[#f0f2f5]" : "hover:bg-[#f5f6f6]"
              }`}
            >
              <Initial a={t.chip} size={44} radius="9999px" />
              <span className="min-w-0 flex-1 border-b border-[#f0f2f5] pb-2.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[14px] text-[#111b21]">{t.name}</span>
                  <span className={`shrink-0 text-[12px] tabular-nums ${i === active ? "text-[#25d366]" : "text-[#667781]"}`}>
                    {t.time}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="block min-w-0 flex-1 truncate text-[13px] text-[#667781]">{t.preview}</span>
                  {i === active && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#25d366] px-1 text-[11px] font-semibold text-white">
                      1
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function TgSidebar({ active, onPick }: { active: number; onPick: (i: number) => void }) {
  return (
    <aside aria-label="Chats" className={`${SIDEBAR} border-r border-[#e6e9ec] bg-white`}>
      <div className="flex h-[56px] shrink-0 items-center gap-3 px-3">
        <span aria-hidden="true" className="flex flex-col gap-[3px] text-[#707579]">
          <span className="block h-[2px] w-[18px] rounded-full bg-current" />
          <span className="block h-[2px] w-[18px] rounded-full bg-current" />
          <span className="block h-[2px] w-[18px] rounded-full bg-current" />
        </span>
        <span className="min-w-0 flex-1">
          <SearchPill tone="telegram" />
        </span>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-1.5">
        {THREADS.map((t, i) => (
          <li key={t.channel}>
            <button
              type="button"
              aria-current={i === active}
              onClick={() => onPick(i)}
              className={`flex w-full items-center gap-2.5 rounded-cta px-2 py-2 text-left transition-colors ${
                i === active ? "bg-[#3390ec]" : "hover:bg-[#f1f3f5]"
              }`}
            >
              <Initial a={t.chip} size={42} radius="9999px" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-[14px] font-semibold ${i === active ? "text-white" : "text-[#0f1620]"}`}>
                    {t.name}
                  </span>
                  <span className={`shrink-0 text-[12px] tabular-nums ${i === active ? "text-white/80" : "text-[#a8a8a8]"}`}>
                    {t.time}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={`block min-w-0 flex-1 truncate text-[13px] ${i === active ? "text-white/85" : "text-[#707579]"}`}>
                    {t.preview}
                  </span>
                  {i === active && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-1 text-[11px] font-semibold text-[#3390ec]">
                      1
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Actions({ labels, variant }: { labels: [string, string]; variant: "whatsapp" | "telegram" }) {
  if (variant === "whatsapp") {
    return (
      <div className="zavi-chat-fade -mx-2.5 -mb-1.5 mt-2 flex flex-col">
        {labels.map((l) => (
          <button
            key={l}
            type="button"
            className="flex h-10 items-center justify-center gap-2 border-t border-[#e9edef] text-[14px] font-medium transition-colors hover:bg-[#f5f6f6]"
            style={{ color: WA_LINK }}
          >
            {l}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="zavi-chat-fade -mx-2 -mb-1 mt-2 flex flex-col gap-[2px]">
      {labels.map((l) => (
        <button
          key={l}
          type="button"
          className="flex h-10 items-center justify-center rounded-cta bg-[#3390ec]/[0.08] text-[14px] font-medium text-[#3390ec] transition-colors hover:bg-[#3390ec]/[0.14]"
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Answer({ t, typing, variant }: { t: Thread; typing: boolean; variant: "whatsapp" | "telegram" }) {
  if (typing) return <TypingDots />;
  return (
    <>
      <p>{t.answer}</p>
      {t.bullets && (
        <ul className="flex flex-col gap-2">
          {t.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]"
                style={{ background: variant === "whatsapp" ? "#25d366" : TG_BLUE }}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={3}>
                  <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="zavi-chat-step">
        <AnswerCard card={t.card} />
      </div>
      <Actions labels={t.actions} variant={variant} />
    </>
  );
}

function Composer({ variant }: { variant: "whatsapp" | "telegram" }) {
  const wa = variant === "whatsapp";
  const Smiley = (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" fill="none" stroke={wa ? "#54656f" : TG_MUTED} strokeWidth={1.7} strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 14.5c.9.9 4.1.9 5 0M9.5 10h.01M14.5 10h.01" />
    </svg>
  );
  const Clip = (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" fill="none" stroke={wa ? "#54656f" : TG_MUTED} strokeWidth={1.7} strokeLinecap="round">
      <path d="M16.5 6.5 8.4 14.6a2.6 2.6 0 0 0 3.7 3.7l8.1-8.1a4.4 4.4 0 1 0-6.2-6.2l-8.2 8.2a6.2 6.2 0 0 0 8.8 8.8l6.9-6.9" />
    </svg>
  );

  if (wa) {
    return (
      <div aria-hidden="true" className="flex h-[62px] shrink-0 items-center gap-3 bg-[#f0f2f5] px-4">
        {Smiley}
        {Clip}
        <span className="flex h-[42px] min-w-0 flex-1 items-center rounded-[8px] bg-white px-4 text-[14px] text-[#8696a0]">
          Type a message
        </span>
        <svg viewBox="0 0 24 24" className="size-6 shrink-0" fill="none" stroke="#54656f" strokeWidth={1.7} strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
        </svg>
      </div>
    );
  }

  return (
    <div aria-hidden="true" className="flex h-[68px] shrink-0 items-center gap-2.5 border-t border-[#e6e9ec] bg-white px-4">
      <span className="flex h-[44px] min-w-0 flex-1 items-center gap-3 rounded-[22px] bg-[#f1f3f5] px-4">
        {Smiley}
        <span className="min-w-0 flex-1 truncate text-[14px] text-[#707579]">Message</span>
        {Clip}
      </span>
      <span className="flex size-[44px] shrink-0 items-center justify-center rounded-full bg-[#3390ec]">
        <svg viewBox="0 0 24 24" className="size-5 text-white" fill="currentColor">
          <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" />
        </svg>
      </span>
    </div>
  );
}

function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 60);
    return () => window.clearTimeout(id);
  }, [dep]);
  return ref;
}

function BubbleTail({
  side,
  color,
  at = "top",
}: {
  side: "left" | "right";
  color: string;
  at?: "top" | "bottom";
}) {
  return (
    <svg
      viewBox="0 0 8 13"
      aria-hidden="true"
      className={`absolute h-[13px] w-2 ${at === "top" ? "top-0" : "bottom-0 -scale-y-100"} ${
        side === "left" ? "-left-[7px]" : "-right-[7px] -scale-x-100"
      }`}
      fill={color}
    >
      <path d="M8 0H5.2C2.3 0 0 2.4 0 5.3 0 8.7 2.6 11.6 6 12.9c.9.3 2 .2 2-.8z" />
    </svg>
  );
}

function WaConversation({ t, typing }: { t: Thread; typing: boolean }) {
  const scroller = useStickToBottom(typing);
  return (
    <section className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex h-[59px] shrink-0 items-center gap-3 bg-[#f0f2f5] px-4">
        <Initial a={t.chip} size={40} radius="9999px" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] text-[#111b21]">{t.name}</span>
          <span className="block text-[13px] text-[#667781]">online</span>
        </span>
        <span aria-hidden="true" className="flex items-center gap-5 text-[#54656f]">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </span>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{
          backgroundColor: WA_WALL,
          backgroundImage:
            "radial-gradient(circle at 18% 22%, rgba(17,27,33,0.045) 0 2px, transparent 2px), radial-gradient(circle at 72% 64%, rgba(17,27,33,0.04) 0 2px, transparent 2px)",
          backgroundSize: "132px 132px, 96px 96px",
        }}
      >
        <div className="flex min-h-full flex-col justify-end gap-2.5 px-4 py-4 sm:px-6">
          <div className="zavi-chat-in flex justify-end">
            <div className="relative max-w-[78%] rounded-[8px] rounded-tr-none px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]" style={{ background: WA_OUT }}>
              <BubbleTail side="right" color={WA_OUT} />
              <p className="text-[13px] font-semibold text-[#079e6d]">{t.asker.name}</p>
              <p className="mt-0.5 whitespace-pre-line text-[14.2px] leading-[19px] text-[#111b21]">
                <span className="font-medium text-[#027eb5]">@Zavi</span> {t.question}
              </p>
              <span className="mt-0.5 flex items-center justify-end gap-1">
                <span className="text-[11px] tabular-nums text-[#667781]">{t.time}</span>
                <DoubleCheck color="#53bdeb" />
              </span>
            </div>
          </div>
          <div className="zavi-chat-in flex justify-start">
            <div className="relative max-w-[86%] rounded-[8px] rounded-tl-none bg-white px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
              <BubbleTail side="left" color="#ffffff" />
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#6a4bb8]">
                Zavi
                <span className="rounded-[3px] bg-[#e9edef] px-1 text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#667781]">
                  business
                </span>
              </p>
              <div className="mt-1 flex flex-col gap-2.5 text-[14.2px] leading-[19px] text-[#111b21]">
                <Answer t={t} typing={typing} variant="whatsapp" />
              </div>
              <span className="mt-1 flex items-center justify-end gap-2">
                {!typing &&
                  t.reactions.map(([e, n]) => (
                    <span
                      key={e}
                      className="zavi-pop-in inline-flex items-center gap-0.5 rounded-full border border-[#e9edef] bg-white px-1.5 text-[11px] leading-[18px] tabular-nums text-[#667781] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]"
                    >
                      <span aria-hidden="true">{e}</span>
                      {n}
                    </span>
                  ))}
                <span className="text-[11px] tabular-nums text-[#667781]">{typing ? "typing…" : t.answerTime}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <Composer variant="whatsapp" />
    </section>
  );
}

function TgConversation({ t, typing }: { t: Thread; typing: boolean }) {
  const scroller = useStickToBottom(typing);
  return (
    <section className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex h-[56px] shrink-0 items-center gap-3 border-b border-[#e6e9ec] bg-white px-4">
        <Initial a={t.chip} size={40} radius="9999px" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-[#0f1620]">{t.name}</span>
          <span className="block text-[13px] text-[#707579]">bot</span>
        </span>
        <span aria-hidden="true" className="flex items-center gap-5 text-[#707579]">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </span>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{
          backgroundImage:
            "radial-gradient(120% 90% at 12% 0%, #eaf1f8 0%, #dde8f2 46%, #d5e2ef 100%)",
        }}
      >
        <div className="flex min-h-full flex-col justify-end gap-2.5 px-4 py-4 sm:px-6">
          <div className="zavi-chat-in flex justify-end">
            <div className="relative max-w-[78%] rounded-[12px] rounded-br-none px-3 py-1.5 shadow-[0_1px_2px_rgba(16,35,47,0.15)]" style={{ background: TG_OUT }}>
              <BubbleTail side="right" color={TG_OUT} at="bottom" />
              <p className="text-[13px] font-semibold text-[#3390ec]">{t.asker.name}</p>
              <p className="mt-0.5 text-[14px] leading-[20px] text-[#0f1620]">
                <span className="font-medium text-[#3390ec]">@Zavi</span> {t.question}
              </p>
              <span className="mt-0.5 flex items-center justify-end gap-1">
                <span className="text-[12px] tabular-nums text-[#62a881]">{t.time}</span>
                <DoubleCheck color="#4fae4e" />
              </span>
            </div>
          </div>
          <div className="zavi-chat-in flex justify-start">
            <div className="relative max-w-[86%] rounded-[12px] rounded-bl-none bg-white px-3 py-2 shadow-[0_1px_2px_rgba(16,35,47,0.15)]">
              <BubbleTail side="left" color="#ffffff" at="bottom" />
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#3390ec]">
                Zavi
                <span className="rounded-[4px] bg-[#3390ec]/10 px-1 text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#3390ec]">
                  bot
                </span>
              </p>
              <div className="mt-1 flex flex-col gap-2.5 text-[14px] leading-[20px] text-[#0f1620]">
                <Answer t={t} typing={typing} variant="telegram" />
              </div>
              <span className="mt-1 flex items-center justify-end gap-2">
                {!typing &&
                  t.reactions.map(([e, n]) => (
                    <span
                      key={e}
                      className="zavi-pop-in inline-flex items-center gap-0.5 rounded-full bg-[#3390ec]/10 px-1.5 text-[12px] leading-[18px] tabular-nums text-[#3390ec]"
                    >
                      <span aria-hidden="true">{e}</span>
                      {n}
                    </span>
                  ))}
                <span className="text-[12px] tabular-nums text-[#707579]">{typing ? "typing…" : t.answerTime}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <Composer variant="telegram" />
    </section>
  );
}

export function ChatPreview({ skin }: { skin: "whatsapp" | "telegram" }) {
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (reduced) return;
    setTyping(true);
    const settle = window.setTimeout(() => setTyping(false), TYPING_MS);
    const next = window.setTimeout(() => setI((n) => (n + 1) % THREADS.length), ROTATE_MS);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(next);
    };
  }, [i, reduced]);

  function pick(n: number) {
    if (n === i) return;
    setI(n);
  }

  const t = THREADS[i];
  const wa = skin === "whatsapp";

  return (
    <PreviewFrame
      label={`Preview of Zavi in ${wa ? "WhatsApp" : "Telegram"}`}
      inner={wa ? "border-[#d1d7db] bg-[#efeae2]" : "border-[#e6e9ec] bg-white"}
      style={{
        fontFamily: wa
          ? '"Segoe UI", "Helvetica Neue", Helvetica, system-ui, -apple-system, sans-serif'
          : '"Roboto", system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      {wa ? <WaSidebar active={i} onPick={pick} /> : <TgSidebar active={i} onPick={pick} />}
      {wa ? <WaConversation key={i} t={t} typing={typing} /> : <TgConversation key={i} t={t} typing={typing} />}
    </PreviewFrame>
  );
}
