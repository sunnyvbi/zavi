
import {
  Brain,
  CalendarCheck,
  FilePenLine,
  Github,
  ImageIcon,
  LayoutTemplate,
  LockOpen,
  MapIcon,
  Megaphone,
  MessageCircleQuestion,
  MessagesSquare,
  PenLine,
  Plane,
  Plug,
  Rocket,
  ScanSearch,
  Search,
  Share2,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";

export type TutorialTier = "Free" | "Starter" | "Growth" | "Pro";
export type TutorialStatus = "ready" | "coming_soon";

export const TUTORIAL_GROUPS = [
  { id: "start", title: "Start here" },
  { id: "get-found", title: "Get found" },
  { id: "social", title: "Social" },
  { id: "build", title: "Build" },
  { id: "automate", title: "Automate" },
  { id: "ads", title: "Ads" },
] as const;

export type TutorialGroupId = (typeof TUTORIAL_GROUPS)[number]["id"];

export type MascotPose =
  | "look-left"
  | "surprised"
  | "delighted"
  | "wide-eyes"
  | "star-eyes"
  | "heart"
  | "up-left"
  | "front";

export type TutorialPoster = {
  title: string;
  pose: MascotPose;
  icon: LucideIcon;
  screen?: string;
};

export type Tutorial = {
  slug: string;
  number: number;
  group: TutorialGroupId;
  title: string;
  description: string;
  tier: TutorialTier;
  durationSec?: number;
  videoUrl?: string;
  posterUrl?: string;
  status: TutorialStatus;
  poster: TutorialPoster;
};

export const TUTORIALS_CDN_BASE = (process.env.NEXT_PUBLIC_TUTORIALS_CDN_BASE ?? "").replace(/\/+$/, "");

export function tutorialAssetUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  if (!TUTORIALS_CDN_BASE) return undefined;
  return `${TUTORIALS_CDN_BASE}/${path.replace(/^\/+/, "")}`;
}

export function isPlayable(t: Tutorial): boolean {
  return t.status === "ready" && tutorialAssetUrl(t.videoUrl) !== undefined;
}

export function formatDuration(sec: number | undefined): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const row = (
  number: number,
  group: TutorialGroupId,
  tier: TutorialTier,
  slug: string,
  title: string,
  description: string,
  poster: TutorialPoster,
  durationSec?: number,
): Tutorial => ({
  slug,
  number,
  group,
  title,
  description,
  tier,
  durationSec,
  status: "coming_soon",
  poster,
});

const MEDIA = "https://media.zaviagent.com/tutorials";
const ready = (t: Tutorial, file: string): Tutorial => ({
  ...t,
  status: "ready",
  videoUrl: `${MEDIA}/${file}.mp4`,
  posterUrl: `${MEDIA}/${file}.jpg`,
  poster: { ...t.poster, screen: `/tutorial-screens/${file}-screen.webp` },
});

export const TUTORIALS: readonly Tutorial[] = [
  ready(row(1, "start", "Free", "set-up-zavi", "Get started: set up Zavi for your business",
    "New to Zavi? Give it your website, your past work and your apps, answer a few questions, and Zavi writes a growth plan for your business. We explain why each step matters as you go.",
    { title: "Get started", pose: "look-left", icon: Rocket }, 87), "01-get-started"),
  ready(row(2, "start", "Free", "set-a-goal", "Set one goal Zavi tracks",
    "Pick the one number that matters most. Give Zavi today's figure, and it plans around it and tells you if you're on track.", { title: "Set one goal", pose: "up-left", icon: Target }, 69), "08-set-one-goal"),
  ready(row(3, "start", "Free", "read-your-growth-plan", "Read your growth plan and make your first move",
    "Already set up? Learn what each part of your plan means, make it sharper with your notes and your apps, then ask Zavi what to do first.",
    { title: "Read your plan", pose: "look-left", icon: MapIcon }, 86), "02-read-your-plan"),
  ready(row(4, "start", "Free", "check-things-in-chat", "Use chat to check your website, your rivals and more",
    "Ask Zavi in chat to check your site or a rival's, for a score and the one fix that matters most. It can also read any page and show you the ads a rival runs.", { title: "Check things in chat", pose: "surprised", icon: ScanSearch }, 76), "03-check-things-in-chat"),
  ready(row(5, "start", "Free", "connect-your-apps", "Connect the apps that help your business most",
    "Connect your database, payments, search, analytics, chat and ad accounts, so Zavi plans from your real numbers, not guesses. Learn what each one is good for.", { title: "Connect your apps", pose: "star-eyes", icon: Plug }, 86), "04-connect-your-apps"),
  ready(row(6, "start", "Free", "first-free-draft", "Use your first free draft",
    "Zavi drafts the work for you. Open a draft, copy it, post it yourself, then tell Zavi it's done so it knows and can avoid suggesting it again.", { title: "Use your first draft", pose: "delighted", icon: FilePenLine }, 54), "05-first-free-draft"),
  ready(row(7, "start", "Free", "ask-about-a-card", "Ask Zavi about a card you're not sure of",
    "Not sure about something Zavi suggests? Ask it why, right from your plan, before you say yes.", { title: "Ask about a card", pose: "wide-eyes", icon: MessageCircleQuestion }, 73), "06-ask-about-a-card"),
  ready(row(8, "start", "Free", "teach-zavi-your-business", "Answer Zavi's questions and teach it your business",
    "Fix anything Zavi has wrong about you, add your rivals, your voice and your rules, and answer its questions from email or Slack.", { title: "Teach Zavi your business", pose: "heart", icon: Brain }, 77), "07-teach-zavi-your-business"),
  ready(row(9, "get-found", "Pro", "first-seo-fixes", "Approve your first SEO fixes and let Zavi open the pull request",
    "On Pro, with your site's GitHub connected: Zavi finds what keeps your site out of search and writes the fix. Approve it, and Zavi opens a pull request for you to check and merge.", { title: "Approve SEO fixes", pose: "look-left", icon: Search }, 62), "09-approve-seo-fixes"),
  ready(row(10, "get-found", "Free", "free-plan-and-unlocking", "See what Free covers, and when to unlock a channel",
    "See what Free covers, use the drafts from your first round, and unlock a channel when you want Zavi to keep doing it.", { title: "What Free covers", pose: "delighted", icon: LockOpen }, 60), "10-what-free-covers"),
  ready(row(11, "get-found", "Pro", "show-up-in-ai-answers", "Show up in AI answers: approve the fix, and Zavi opens the pull request",
    "On Pro, with your site's GitHub connected: Zavi finds what keeps your site out of AI answers and writes the fix. Approve it, and Zavi opens a pull request for you to check and merge.", { title: "Show up in AI answers", pose: "star-eyes", icon: Sparkles }, 61), "11-show-up-in-ai-answers"),
  ready(row(12, "get-found", "Starter", "write-a-blog-post", "Write a blog post your buyers search for",
    "Zavi picks a topic people already search for and writes the post. Make it yours, put it on your blog, and tell Zavi it's up.", { title: "Write a blog post", pose: "front", icon: PenLine }, 54), "12-write-a-blog-post"),
  ready(row(13, "social", "Starter", "reddit-replies", "Find Reddit threads worth answering and post a helpful reply",
    "Zavi finds threads where people ask about what you do and drafts a reply that helps first. Edit it, then post it from your connected Reddit account.", { title: "Reply on Reddit", pose: "wide-eyes", icon: MessagesSquare }, 50), "13-reply-on-reddit"),
  ready(row(14, "social", "Starter", "linkedin-and-x-posts", "Turn your story into LinkedIn and X posts",
    "Zavi writes posts from your story, in your voice. Make them sound like you, then post from your account, or open LinkedIn with the post filled in.", { title: "LinkedIn and X posts", pose: "heart", icon: Share2 }, 46), "14-linkedin-and-x-posts"),
  ready(row(15, "social", "Starter", "instagram-posts", "Post a photo to Instagram with a caption Zavi writes",
    "Add a photo and Zavi writes the caption. It waits for you to check, then posts from your connected Instagram account when you approve.", { title: "Post to Instagram", pose: "delighted", icon: ImageIcon }, 41), "15-post-to-instagram"),
  ready(row(16, "build", "Free", "build-a-landing-page", "Build a landing page for a new idea and put it live",
    "Got a new idea? Describe it in plain words, shape the page by chatting, and put it live at its own address, so you can see who signs up before you spend more.", { title: "Build a landing page", pose: "star-eyes", icon: LayoutTemplate }, 44), "16-build-a-landing-page"),
  ready(row(17, "build", "Starter", "site-on-github", "Put your Zavi-built site on GitHub",
    "Export your Zavi-built site's code to your own GitHub, so you own it and any developer can work on it. Export again any time to send your latest changes.", { title: "Your site on GitHub", pose: "front", icon: Github }, 51), "17-site-on-github"),
  ready(row(18, "automate", "Starter", "weekly-check", "Get a weekly check-in from an agent you build",
    "Tell Agent Builder what to check and when, in plain words. Zavi drafts the agent, you turn it on, and you try it once to see a real result.", { title: "Weekly check-in", pose: "up-left", icon: CalendarCheck }, 40), "18-weekly-check-in"),
  ready(row(19, "automate", "Free", "autopilot-and-needs-you", "Turn on Autopilot and approve its moves",
    "Turn on Autopilot so Zavi keeps working on your goal without being asked. Approve or reject what waits for your OK, and pause it any time.", { title: "Autopilot", pose: "star-eyes", icon: Plane }, 44), "19-autopilot-and-needs-you"),
  ready(row(20, "ads", "Pro", "meta-ad-budget", "Set your ad budget and approve your first Meta ad",
    "Set the monthly amount Zavi plans your ads around, then read and approve your first Meta ad. The changes Zavi makes in your Meta ad account are listed on Growth.", { title: "Meta ad budget", pose: "wide-eyes", icon: Megaphone }, 53), "20-meta-ad-budget"),
];

export function tutorialsByGroup(list: readonly Tutorial[] = TUTORIALS) {
  return TUTORIAL_GROUPS.map((g) => ({
    ...g,
    items: list.filter((t) => t.group === g.id).sort((a, b) => a.number - b.number),
  })).filter((g) => g.items.length > 0);
}
