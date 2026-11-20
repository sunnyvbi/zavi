"use client";
/* eslint-disable @next/next/no-img-element */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChatPreview } from "./growth-home/ChatPreview";
import { PREVIEW_FRAME_MAX_W, PreviewFrame, ZaviAvatar } from "./growth-home/PreviewFrame";
import { StepGlyph } from "./growth-home/stepIcons";
import { inter, jakarta, lato } from "@/fonts";

type Tab = "teams" | "slack" | "whatsapp" | "telegram";

const CHAT_TABS = {
  whatsapp: { label: "WhatsApp", glyph: "WhatsApp" },
  telegram: { label: "Telegram", glyph: "Telegram" },
} as const;

const SARAH_AVATAR = "/marketing/sarah-jenkins.png";
const TEAMS_LOGO = "/logos/teams.svg";
const SLACK_LOGO = "/logos/slack-color.svg";
const tm = (n: string) => `/marketing/teams/${n}.svg`;
const sl = (n: string) => `/marketing/slack/${n}.svg`;

const BULLETS = [
  "Frontend components merged into production",
  "API documentation updated for V2 endpoints",
  "Marketing assets finalized for the Q4 launch",
];

const SLACK_CHANNELS = ["general", "project-updates", "engineering", "design", "random"];

type TeamsRow = {
  name: string;
  time: string;
  preview: string;
  initials?: string;
  color?: string;
  unread?: number;
  active?: boolean;
  zavi?: boolean;
  bold?: boolean;
};
const TEAMS_ROWS: TeamsRow[] = [
  { name: "Zavi", time: "10:05 AM", preview: "Here's a summary of the latest updates…", active: true, zavi: true },
  { name: "Alex Chen", time: "9:48 AM", preview: "See you at the design meeting!", initials: "AC", color: "#2e8f73", unread: 3, bold: true },
  { name: "Design Team", time: "9:30 AM", preview: "David: Just uploaded new mockups for v2", initials: "DT", color: "#cc5933" },
  { name: "Sarah Johnson", time: "Yesterday", preview: "Can you review this document?", initials: "SJ", color: "#2e6bb8", unread: 1, bold: true },
  { name: "Marketing Channel", time: "Yesterday", preview: "Kate: Campaign launch tomorrow!", initials: "MC", color: "#b82e6b", unread: 5, bold: true },
  { name: "David Park", time: "Mon", preview: "Sent a file: project_proposal_final.pdf", initials: "DP", color: "#2e99b2" },
  { name: "Project Updates", time: "Mon", preview: "Sprint 14 has officially started.", initials: "PU", color: "#8f5c2e" },
  { name: "Emma Wilson", time: "Sun", preview: "Thanks, I'll update the slides.", initials: "EW", color: "#5c2e8f" },
];

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const Item = ({
    id,
    logo,
    label,
    iconClass,
    glyph,
  }: {
    id: Tab;
    logo?: string;
    label: string;
    iconClass: string;
    glyph?: string;
  }) => {
    const active = tab === id;
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        aria-label={label}
        title={label}
        className={`flex h-10 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-blockLg px-2 text-[16px] font-semibold tracking-[0.01px] transition-colors sm:flex-none sm:gap-2 sm:px-4 ${
          active ? "bg-white text-[#1f1f1f] shadow-[0px_1px_2px_rgba(16,24,40,0.06)]" : "text-[#454545]"
        }`}
      >
        {glyph ? (
          <StepGlyph name={glyph} className={`${iconClass} shrink-0`} />
        ) : (
          <img src={logo} alt="" className={`${iconClass} shrink-0`} />
        )}
        <span className="hidden sm:inline">{label}</span>
      </button>
    );
  };
  return (
    <div className="flex w-full items-center gap-1 rounded-full bg-[#f0f0f0] p-1 sm:inline-flex sm:w-fit sm:flex-wrap sm:justify-center sm:rounded-[43px]">
      <Item id="teams" logo={TEAMS_LOGO} label="Microsoft Teams" iconClass="size-5 sm:size-[18px]" />
      <Item id="slack" logo={SLACK_LOGO} label="Slack" iconClass="size-5 sm:size-[18px]" />
      <Item id="whatsapp" glyph={CHAT_TABS.whatsapp.glyph} label={CHAT_TABS.whatsapp.label} iconClass="size-5 sm:size-[18px]" />
      <Item id="telegram" glyph={CHAT_TABS.telegram.glyph} label={CHAT_TABS.telegram.label} iconClass="size-5 sm:size-[18px]" />
    </div>
  );
}

function LeftColumn({ tab, startHref }: { tab: Tab; startHref: string }) {
  const teams = tab === "teams";

  if (tab === "whatsapp" || tab === "telegram") {
    const { label, glyph } = CHAT_TABS[tab];
    return (
      <div className="flex w-full max-w-[507px] flex-col gap-10">
        <div className="flex flex-col gap-6">
          <span className="flex h-[41px] w-fit items-center gap-2 rounded-full border border-[rgba(14,15,17,0.1)] bg-white/20 px-4">
            <StepGlyph name={glyph} className="size-[22px] shrink-0" />
            <span className="font-[family-name:var(--font-inter)] text-[16px] font-medium tracking-[0.35px] text-[#0e0f11]">
              LIVE IN {label}
            </span>
          </span>
          <h2 className="text-[36px] font-bold leading-[1.12] tracking-[-0.5px] text-[#0e0f11] md:text-[44px] lg:text-[52px] lg:leading-[72px] lg:tracking-[-1.04px]">
            Meet your AI
            <br />
            growth agent.
          </h2>
          <p className="max-w-[470px] text-[16px] font-normal leading-[26px] tracking-[0.16px] text-[#1f1f1f]">
            Zavi works inside the tools your team already uses, reads the context, and drafts the next action in
            seconds, right where the work happens.
          </p>
        </div>
        <Link
          href={startHref}
          className="inline-flex h-12 w-[270px] items-center justify-center whitespace-nowrap rounded-full bg-[#0e0f11] px-4 text-[16px] font-semibold tracking-[0.01px] text-white transition-colors hover:bg-[#26282b]"
        >
          Add to {label}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[507px] flex-col gap-10">
      <div className="flex flex-col gap-6">
        <span className="flex h-[41px] w-fit items-center gap-2 rounded-full border border-[rgba(14,15,17,0.1)] bg-white/20 px-4">
          <img src={teams ? TEAMS_LOGO : SLACK_LOGO} alt="" className={`${teams ? "size-[25px]" : "size-[22px]"} shrink-0`} />
          <span className="font-[family-name:var(--font-inter)] text-[16px] font-medium tracking-[0.35px] text-[#0e0f11]">
            LIVE IN {teams ? "TEAMS" : "Slack"}
          </span>
        </span>
        <h2 className="text-[36px] font-bold leading-[1.12] tracking-[-0.5px] text-[#0e0f11] md:text-[44px] lg:text-[52px] lg:leading-[72px] lg:tracking-[-1.04px]">
          Meet your AI
          <br />
          growth agent.
        </h2>
        <p className="max-w-[470px] text-[16px] font-normal leading-[26px] tracking-[0.16px] text-[#1f1f1f]">
          Zavi works inside the tools your team already uses, reads the context, and drafts the next action in seconds, right where the work happens.
        </p>
      </div>
      <Link href={startHref} className="inline-flex h-12 w-[270px] items-center justify-center whitespace-nowrap rounded-full bg-[#0e0f11] px-4 text-[16px] font-semibold tracking-[0.01px] text-white transition-colors hover:bg-[#26282b]">
        Get started with {teams ? "Microsoft Teams" : "Slack"}
      </Link>
    </div>
  );
}

function SlackSidebar() {
  const SectionHead = ({ label }: { label: string }) => (
    <div className="flex items-center justify-between px-4 py-1">
      <span className="text-[13px] font-bold uppercase tracking-[0.2px] text-[#595959]">{label}</span>
      <span className="text-[14px] leading-none text-[#868686]">+</span>
    </div>
  );
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[#e8e8e8] bg-[#f9f9f9] font-[family-name:var(--font-inter)] sm:flex">
      <div className="flex h-[54px] shrink-0 items-center justify-between border-b border-[#d9d9d9] px-4">
        <span className="text-[20px] font-semibold text-[#0e0f11]">Acme Inc</span>
        <img src={sl("chevron")} alt="" className="size-3" />
      </div>
      <div className="flex flex-col gap-1 pt-5">
        <SectionHead label="Channels" />
        {SLACK_CHANNELS.map((name) =>
          name === "project-updates" ? (
            <div key={name} className="mx-1 flex items-center gap-2 rounded-[6px] bg-[#0e0f11] px-2.5 py-1.5 text-white">
              <span className="text-[20px] leading-none">#</span>
              <span className="text-[14px] font-bold">{name}</span>
            </div>
          ) : (
            <div key={name} className="flex items-center gap-2 px-4 py-1.5">
              <span className="text-[20px] leading-none text-[#a0a0a0]">#</span>
              <span className="text-[14px] text-[#595959]">{name}</span>
            </div>
          ),
        )}
      </div>
      <div className="flex flex-col gap-1 pt-5">
        <SectionHead label="Apps" />
        <div className="flex items-center gap-2 px-4 py-1.5">
          <ZaviAvatar size={19} radius="3px" />
          <span className="text-[14px] text-[#595959]">Zavi</span>
        </div>
      </div>
    </aside>
  );
}

function TeamsSidebar() {
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col overflow-hidden border-r border-[#e1e1e1] bg-[#f9f9f9] sm:flex">
      <div className="flex h-[52px] shrink-0 items-center px-4">
        <span className="text-[20px] font-semibold text-[#212121]">Chat</span>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-[16px] bg-[#ededf2] px-3">
          <span className="text-[12px]">🔍</span>
          <span className="text-[13px] text-[#808080]">Search</span>
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center bg-[#f5f5f7] px-4">
        <span className="text-[11px] font-medium text-[#808080]">Recent</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {TEAMS_ROWS.map((r) => (
          <div key={r.name} className={`relative flex h-16 shrink-0 items-center gap-3 pl-3.5 pr-3 ${r.active ? "bg-[#e0e0f2]" : ""}`}>
            {r.active && <span className="absolute left-0 top-4 h-8 w-[3px] rounded-[2px] bg-[#5c4ab5]" />}
            {r.zavi ? (
              <ZaviAvatar size={40} radius="12px" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white" style={{ background: r.color }}>
                {r.initials}
              </span>
            )}
            <div className={`flex h-full min-w-0 flex-1 flex-col justify-center ${r.active ? "" : "border-b border-[#ebebed]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-[13px] ${r.bold ? "font-semibold text-[#212121]" : "font-medium text-[#333]"}`}>{r.name}</span>
                <span className="shrink-0 text-[11px] text-[#808080]">{r.time}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] text-[#808080]">{r.preview}</span>
                {r.unread ? (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#5c4ab5] text-[11px] font-bold text-white">{r.unread}</span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function TeamsWindow() {
  return (
    <PreviewFrame
      label="Preview of Zavi in Microsoft Teams"
      inner="border-[#e1e1e1] bg-white font-[family-name:var(--font-inter)]"
    >
      <TeamsSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between bg-[#6264a7] px-4">
        <div className="flex items-center gap-3">
          <img src={tm("back")} alt="" className="h-3.5 w-2" />
          <span className="flex size-8 items-center justify-center rounded-[6px] bg-white/20">
            <ZaviAvatar size={30} radius="8px" />
          </span>
          <span className="text-[16px] font-semibold tracking-[0.4px] text-white">Zavi</span>
        </div>
        <div className="flex items-center gap-4">
          <img src={tm("video")} alt="" className="h-4 w-[18px]" />
          <img src={tm("phone")} alt="" className="size-4" />
          <img src={tm("info")} alt="" className="size-4" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden bg-[#f5f5f5] p-6">
        <div className="flex items-start justify-end gap-2 pl-12">
          <div className="flex flex-col items-end">
            <div className="max-w-[349px] rounded-bl-[8px] rounded-br-[8px] rounded-tl-[8px] border border-[#d1d1f0] bg-[#e2e2f6] px-3 py-3 shadow-[0px_1px_1px_rgba(0,0,0,0.05)]">
              <p className="text-[16px] font-normal leading-[21px] text-[#242424]">@Zavi Hi, can you summarize the latest project updates?</p>
            </div>
            <span className="pt-1 text-[11px] font-normal text-[#616161]">10:04 AM</span>
          </div>
          <img src={SARAH_AVATAR} alt="" className="size-8 shrink-0 rounded-full object-cover" />
        </div>
        <div className="flex items-start gap-2">
          <ZaviAvatar size={32} radius="8px" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 pb-1">
              <span className="text-[13px] font-bold text-[#242424]">Zavi</span>
              <span className="rounded-[2px] bg-[#edebe9] px-1 text-[9px] font-bold text-[#616161]">BOT</span>
              <span className="text-[11px] font-normal text-[#616161]">10:05 AM</span>
            </div>
            <div className="flex flex-col gap-2 rounded-b-[8px] rounded-tr-[8px] border border-[#e1e1e1] bg-white p-4 shadow-[0px_1px_1px_rgba(0,0,0,0.05)]">
              <p className="text-[16px] font-semibold leading-[21px] text-[#242424]">Here&rsquo;s a summary of the latest updates:</p>
              <ul className="flex flex-col gap-1">
                {BULLETS.map((b) => (
                  <li key={b} className="flex gap-2 text-[13px] font-normal leading-[19.5px] text-[#424242]">
                    <span aria-hidden>•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2 pt-2">
                <span className="rounded-[4px] border border-[#d1d1d1] bg-white px-3 py-1.5 text-[12px] font-medium text-[#242424]">Approved</span>
                <span className="rounded-[4px] border border-[#d1d1d1] bg-white px-3 py-1.5 text-[12px] font-medium text-[#242424]">Discuss</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-[#e1e1e1] bg-[#f5f5f5] p-4">
        <div className="flex flex-col gap-4 rounded-[6px] border border-[#c1c1c1] bg-white p-3 shadow-[inset_0px_2px_4px_rgba(0,0,0,0.05)]">
          <p className="text-[16px] font-normal italic leading-5 text-[#616161]">Drafting response...</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={tm("fmtA")} alt="" className="h-4 w-3.5" />
              <img src={tm("attach")} alt="" className="h-4 w-3.5" />
              <img src={tm("emoji")} alt="" className="size-4" />
              <img src={tm("gift")} alt="" className="size-4" />
            </div>
            <span className="flex size-8 items-center justify-center rounded-[4px] bg-[#6264a7]">
              <img src={tm("send")} alt="" className="size-3" />
            </span>
          </div>
        </div>
      </div>
      </div>
    </PreviewFrame>
  );
}

function SlackWindow() {
  const Reaction = ({ emoji, n }: { emoji: string; n: number }) => (
    <span className="flex items-center gap-2 rounded-full border border-[#e8e8e8] bg-[#f8f8f8] px-2 py-0.5 text-[11px] font-bold">
      <span>{emoji}</span>
      <span className="text-[#1264a3]">{n}</span>
    </span>
  );
  return (
    <PreviewFrame
      label="Preview of Zavi in Slack"
      inner="border-[#e8e8e8] bg-white font-[family-name:var(--font-lato)]"
    >
      <SlackSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
      {}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#e8e8e8] px-4">
        <div className="flex items-center gap-2">
          <span className="text-[20px] font-black text-black"># project-updates</span>
          <img src={sl("chevron")} alt="" className="size-2.5" />
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center">
            <img src="/marketing/slack/member1.jpg" alt="" className="size-6 rounded-[4px] border-2 border-white object-cover" />
            <img src="/marketing/slack/member2.jpg" alt="" className="-ml-2 size-6 rounded-[4px] border-2 border-white object-cover" />
            <span className="-ml-2 flex size-6 items-center justify-center rounded-[4px] border-2 border-white bg-[#f8f8f8] text-[11px] font-bold text-black">12</span>
          </div>
          <img src={sl("info")} alt="" className="size-4" />
        </div>
      </div>
      {}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden py-4">
        {}
        <div className="flex gap-3 px-4 py-2">
          <img src={SARAH_AVATAR} alt="" className="size-9 shrink-0 rounded-[4px] object-cover" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-black text-[#1d1c1d]">Alex Rivera</span>
              <span className="text-[12px] font-normal text-[#616061]">10:04 AM</span>
            </div>
            <p className="text-[14px] font-normal leading-[24px] text-[#1d1c1d]">
              <span className="rounded-[4px] bg-[#e8f5fa] px-1 text-[#1264a3]">@Zavi</span> Hi, can you summarize the latest project updates?
            </p>
          </div>
        </div>
        {}
        <div className="flex gap-3 px-4 py-2">
          <ZaviAvatar size={40} radius="12px" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-black text-[#1d1c1d]">Zavi</span>
              <span className="rounded-[4px] bg-[#f0f0f0] px-1 text-[11px] font-bold uppercase tracking-[0.33px] text-[#616061]">APP</span>
              <span className="text-[12px] font-normal text-[#616061]">10:05 AM</span>
            </div>
            <div className="flex flex-col gap-2 border-l-4 border-[#e8e8e8] py-1 pl-4">
              <p className="text-[14px] font-bold leading-[22.5px] text-[#1d1c1d]">Here&rsquo;s a summary of the latest updates:</p>
              <ul className="flex flex-col gap-[3.5px]">
                {BULLETS.map((b) => (
                  <li key={b} className="text-[14px] font-normal leading-[22.5px] text-[#1d1c1d]">• {b}</li>
                ))}
              </ul>
              <div className="flex gap-2 pt-1">
                <span className="flex items-center gap-2 rounded-[6px] border border-[#e8e8e8] bg-[#f8f8f8] px-2 py-1 text-[13px] font-normal text-black">✅ Approved</span>
                <span className="flex items-center gap-2 rounded-[6px] border border-[#e8e8e8] bg-[#f8f8f8] px-2 py-1 text-[13px] font-normal text-black">💬 Discuss</span>
              </div>
            </div>
            <div className="flex gap-1 pt-1">
              <Reaction emoji="🚀" n={4} />
              <Reaction emoji="🙌" n={2} />
            </div>
          </div>
        </div>
      </div>
      {}
      <div className="shrink-0 p-4">
        <div className="overflow-hidden rounded-[8px] border border-[#bbbabb]">
          <div className="flex h-9 items-center gap-4 border-b border-[#e8e8e8] bg-[#f8f8f8] px-3">
            <img src={sl("bold")} alt="" className="h-4 w-3" />
            <img src={sl("italic")} alt="" className="h-4 w-3" />
            <img src={sl("strike")} alt="" className="size-4" />
            <span className="h-4 w-px bg-[#e8e8e8]" />
            <img src={sl("link")} alt="" className="h-4 w-5" />
            <img src={sl("list")} alt="" className="size-4" />
            <img src={sl("olist")} alt="" className="size-4" />
          </div>
          <div className="px-3 pb-11 pt-3">
            <p className="text-[14px] font-normal italic leading-[22.5px] text-[#616061]">Drafting response...</p>
          </div>
          <div className="flex h-10 items-center justify-between px-3 pb-2">
            <div className="flex items-center gap-3">
              <img src={sl("plus")} alt="" className="size-4" />
              <img src={sl("video")} alt="" className="h-4 w-[18px]" />
              <img src={sl("mic")} alt="" className="h-4 w-3" />
            </div>
            <div className="flex items-center gap-2">
              <img src={sl("emoji")} alt="" className="size-4" />
              <img src={sl("at")} alt="" className="size-4" />
              <span className="h-4 w-px bg-[#e8e8e8]" />
              <span className="flex size-7 items-center justify-center rounded-[4px] bg-[#007a5a]">
                <img src={sl("send")} alt="" className="size-3" />
              </span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </PreviewFrame>
  );
}

const SETUP_STEPS: ReactNode[] = [
  <>Create a Zavi account at zaviagent.com and complete onboarding for your company.</>,
  <>
    Open <span className="font-medium text-[#1f1f1f]">Workspace → Settings → Integrations</span>, choose{" "}
    <span className="font-medium text-[#1f1f1f]">Connect</span> on the Slack tile, and approve the requested permissions
    in your Slack workspace.
  </>,
  <>
    Invite Zavi to the channels it should work in with{" "}
    <span className="font-medium text-[#1f1f1f]">/invite @Zavi</span>. Zavi also creates{" "}
    <span className="font-medium text-[#1f1f1f]">#zavi-updates</span> for its daily summary.
  </>,
];

const TRIGGERS: ReactNode[] = [
  <>
    <span className="font-medium text-[#1f1f1f]">You mention @Zavi</span> in a channel it has been invited to, or reply in
    a thread it is already part of. Zavi answers in that thread.
  </>,
  <>
    <span className="font-medium text-[#1f1f1f]">You send it a direct message</span>, on its own or in a group DM.
  </>,
  <>
    <span className="font-medium text-[#1f1f1f]">On either of those,</span> Zavi adds a reaction to show it picked the
    message up, replies in the thread, and passes anything that needs real work to the right specialist agent.
  </>,
  <>
    <span className="font-medium text-[#1f1f1f]">Nothing else makes it post.</span> Zavi reads the channels it has been
    invited to for context, but it stays quiet there unless you mention it.
  </>,
];

function GuideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col gap-4 rounded-[16px] border border-[#f0f0f0] bg-white p-6 md:p-7">
      <h3 className="text-[16px] font-semibold leading-[24px] tracking-[-0.1px] text-[#0e0f11]">{title}</h3>
      {children}
    </section>
  );
}

function SlackGuide() {
  return (
    <div className="mx-auto w-full max-w-[1338px] rounded-blockLg bg-[#f9f9f9] px-4 py-8 md:px-8 md:py-10 lg:px-10">
      <div className="grid w-full items-stretch gap-4 md:grid-cols-3 md:gap-5">
        <GuideCard title="What Zavi does in Slack">
          <p className="text-[16px] font-normal leading-[23px] text-[#454545]">
            Zavi is an AI growth agent for your business: an operator agent plus specialists for growth, support, engineering and
            operations. Connect your workspace once and that team works inside Slack: it reads the channels you invite it
            to, answers from your company&rsquo;s own context and connected tools, and hands longer work to the right
            specialist. Results are posted back to the same thread.
          </p>
        </GuideCard>

        <GuideCard title="Connecting your workspace">
          <ol className="flex flex-col gap-3">
            {SETUP_STEPS.map((step, i) => (
              <li key={i} className="flex gap-3 text-[16px] font-normal leading-[23px] text-[#454545]">
                <span className="mt-[2px] flex size-[20px] shrink-0 items-center justify-center rounded-full bg-[#f9f9f9] text-[11px] font-semibold text-[#0e0f11]">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </GuideCard>

        <GuideCard title="What Zavi responds to">
          <ul className="flex flex-col gap-3">
            {TRIGGERS.map((t, i) => (
              <li key={i} className="flex gap-3 text-[16px] font-normal leading-[23px] text-[#454545]">
                <span aria-hidden className="mt-[9px] size-[4px] shrink-0 rounded-full bg-[#c4c4c4]" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </GuideCard>
      </div>

      <p className="px-1 pt-6 text-[13px] font-normal leading-[21px] text-[#595959] md:px-2 md:pt-7">
        Zavi reads the channels and conversations you invite it to. It can send a direct message to someone in your
        workspace when a task you asked for needs it, under a strict cap on unsolicited outreach. Message content is
        used solely to produce the output you asked for and is never used to train foundation models. You can remove
        Zavi at any time from your Slack workspace&rsquo;s app management screen. See our{" "}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-[#0e0f11]">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/security" className="underline underline-offset-2 hover:text-[#0e0f11]">
          Security
        </Link>{" "}
        pages for details.
      </p>
    </div>
  );
}

export const CHAT_PANE_CLASS = `w-full min-w-0 ${PREVIEW_FRAME_MAX_W}`;

export default function MeetWithZavi({ startHref = "/start" }: { startHref?: string }) {
  const [tab, setTab] = useState<Tab>("slack");
  return (
    <section className={`${jakarta.variable} ${inter.variable} ${lato.variable} bg-[#f9f9f9] px-3 py-6 font-[family-name:var(--font-jakarta)] md:px-4 md:py-10`}>
      <div className="mx-auto flex max-w-[1460px] flex-col items-center gap-12 rounded-[48px] px-4 py-10 md:gap-16 md:px-10 md:py-16 lg:px-16 lg:py-[80px]">
        <TabBar tab={tab} onChange={setTab} />
        <div className="flex w-full flex-col items-start gap-12 lg:flex-row lg:items-center lg:justify-center lg:gap-16">
          <LeftColumn tab={tab} startHref={startHref} />
          <div className={CHAT_PANE_CLASS}>
            {tab === "whatsapp" || tab === "telegram" ? (
              <ChatPreview skin={tab} />
            ) : tab === "teams" ? (
              <TeamsWindow />
            ) : (
              <SlackWindow />
            )}
          </div>
        </div>
        {}
      </div>
    </section>
  );
}
