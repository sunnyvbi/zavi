
import {
  Database,
  Hammer,
  LayoutDashboard,
  Building2,
  Activity,
  GitPullRequestArrow,
  Brain,
  Bot,
  Cpu,
  ThumbsUp,
  DollarSign,
  Wallet,
  Receipt,
  Split,
  AlertTriangle,
  BarChart3,
  Gauge,
  Clock,
  Filter,
  Rocket,
  Users,
  CreditCard,
  TrendingUp,
  ShieldAlert,
  Gift,
  Settings,
  SlidersHorizontal,
  ClipboardList,
  UserCheck,
  Laptop,
  Plug,
  Trophy,
  TimerReset,
  ScrollText,
  HeartPulse,
  LineChart,
  Send,
  Megaphone,
  ToggleLeft,
  Flag,
  Slack,
  Flame,
  Search,
  UserPlus,
  ShieldCheck,
  Terminal,
  Video,
  Lightbulb,
  Scale,
  Ban,
  HelpCircle,
  Hourglass,
  Radio,
  Tally5,
  Tags,
  MessageSquareWarning,
  Siren,
  Contact,
  Banknote,
  Sprout,
  MessagesSquare,
  Sparkles,
  Clapperboard,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Section = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export type Tone = "health" | "customers" | "money" | "growth" | "voice" | "agents" | "creators" | "system" | "home";

export const TONE_CLASSES: Readonly<
  Record<Tone, { dot: string; icon: string; text: string; activeRow: string; activeBar: string; railTile: string }>
> = {
  health: { dot: "bg-rose-500", icon: "text-rose-600", text: "text-rose-700", activeRow: "bg-rose-50 text-rose-800", activeBar: "bg-rose-500", railTile: "bg-rose-50 text-rose-600" },
  customers: { dot: "bg-sky-500", icon: "text-sky-600", text: "text-sky-700", activeRow: "bg-sky-50 text-sky-800", activeBar: "bg-sky-500", railTile: "bg-sky-50 text-sky-600" },
  money: { dot: "bg-emerald-500", icon: "text-emerald-600", text: "text-emerald-700", activeRow: "bg-emerald-50 text-emerald-800", activeBar: "bg-emerald-500", railTile: "bg-emerald-50 text-emerald-600" },
  growth: { dot: "bg-amber-500", icon: "text-amber-600", text: "text-amber-700", activeRow: "bg-amber-50 text-amber-800", activeBar: "bg-amber-500", railTile: "bg-amber-50 text-amber-600" },
  voice: { dot: "bg-pink-500", icon: "text-pink-600", text: "text-pink-700", activeRow: "bg-pink-50 text-pink-800", activeBar: "bg-pink-500", railTile: "bg-pink-50 text-pink-600" },
  agents: { dot: "bg-violet-500", icon: "text-violet-600", text: "text-violet-700", activeRow: "bg-violet-50 text-violet-800", activeBar: "bg-violet-500", railTile: "bg-violet-50 text-violet-600" },
  creators: { dot: "bg-orange-500", icon: "text-orange-600", text: "text-orange-700", activeRow: "bg-orange-50 text-orange-800", activeBar: "bg-orange-500", railTile: "bg-orange-50 text-orange-600" },
  system: { dot: "bg-slate-400", icon: "text-slate-500", text: "text-slate-600", activeRow: "bg-slate-100 text-slate-900", activeBar: "bg-slate-500", railTile: "bg-slate-100 text-slate-600" },
  home: { dot: "bg-slate-900", icon: "text-slate-700", text: "text-slate-800", activeRow: "bg-slate-100 text-slate-900", activeBar: "bg-slate-900", railTile: "bg-slate-100 text-slate-700" },
};

export type Group = {
  key: Tone;
  title: string | null;
  tone: Tone;
  icon: LucideIcon;
  items: ReadonlyArray<Section>;
};

export const PANIC_STOP: Section = { href: "/fleet-halt", label: "Panic-stop", icon: Ban };

export const GROUPS: ReadonlyArray<Group> = [
  {
    key: "home",
    title: null,
    tone: "home",
    icon: LayoutDashboard,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/search", label: "Search", icon: Search },
    ],
  },
  {
    key: "health",
    title: "Health",
    tone: "health",
    icon: Siren,
    items: [
      { href: "/errors", label: "Errors", icon: AlertTriangle },
      { href: "/stuck-runs", label: "Stuck runs", icon: TimerReset },
      { href: "/cost-anomaly", label: "Cost anomaly", icon: Flame },
      { href: "/crons", label: "Crons", icon: Clock },
    ],
  },
  {
    key: "customers",
    title: "Customers",
    tone: "customers",
    icon: Contact,
    items: [
      { href: "/tenants", label: "Tenants", icon: Building2 },
      { href: "/tenant-health", label: "Tenant health", icon: HeartPulse },
      { href: "/runs", label: "Runs", icon: Activity },
      { href: "/readiness", label: "Readiness", icon: Gauge },
      { href: "/human-actions", label: "Human Actions", icon: UserCheck },
      { href: "/tasks", label: "Tasks", icon: ClipboardList },
      { href: "/members", label: "Seats & members", icon: Users },
    ],
  },
  {
    key: "money",
    title: "Money",
    tone: "money",
    icon: Banknote,
    items: [
      { href: "/revenue", label: "Revenue · MRR", icon: TrendingUp },
      { href: "/billing", label: "Billing", icon: CreditCard },
      { href: "/disputes", label: "Disputes", icon: ShieldAlert },
      { href: "/credit-grants", label: "Credit grants", icon: Gift },
      { href: "/usage-limit", label: "Usage limit", icon: Gauge },
      { href: "/costs", label: "Costs", icon: DollarSign },
      { href: "/tenant-costs", label: "Tenant cost", icon: Wallet },
      { href: "/build-costs", label: "Build cost", icon: Receipt },
      { href: "/model-routing", label: "Routing", icon: Split },
    ],
  },
  {
    key: "growth",
    title: "Growth",
    tone: "growth",
    icon: Sprout,
    items: [
      { href: "/activation", label: "Activation", icon: Rocket },
      { href: "/onboarding", label: "Onboarding", icon: UserPlus },
      { href: "/funnel", label: "Funnel", icon: Filter },
      { href: "/cohorts", label: "Cohorts", icon: LineChart },
      { href: "/value-report", label: "Value report", icon: Hourglass },
      { href: "/actions", label: "Action tracker", icon: Tally5 },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/announcements", label: "Announcements", icon: Megaphone },
      { href: "/notifications", label: "Notifications", icon: Send },
    ],
  },
  {
    key: "voice",
    title: "Customer voice",
    tone: "voice",
    icon: MessagesSquare,
    items: [
      { href: "/feedback", label: "Feedback", icon: ThumbsUp },
      { href: "/suggestions", label: "Suggestions", icon: Lightbulb },
      { href: "/team-notes", label: "Team notes", icon: MessageSquareWarning },
      { href: "/gaps", label: "Gaps", icon: HelpCircle },
    ],
  },
  {
    key: "agents",
    title: "Agents",
    tone: "agents",
    icon: Sparkles,
    items: [
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/decisions", label: "Decisions", icon: GitPullRequestArrow },
      { href: "/quality", label: "Agent quality", icon: Trophy },
      { href: "/agent-performance", label: "Agent performance", icon: BarChart3 },
      { href: "/channels", label: "Channels", icon: Radio },
      { href: "/build-quality", label: "Build quality", icon: Hammer },
      { href: "/card-labels", label: "Card labels", icon: Tags },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/engine", label: "Engine", icon: Cpu },
      { href: "/engine-variants", label: "Engine variants", icon: Cpu },
      { href: "/local-lane", label: "Local lane", icon: Laptop },
    ],
  },
  {
    key: "creators",
    title: "Creators",
    tone: "creators",
    icon: Clapperboard,
    items: [
      { href: "/creator-network/creators", label: "Creators", icon: Users },
      { href: "/creator-network", label: "Creator mediation", icon: Scale },
    ],
  },
  {
    key: "system",
    title: "System",
    tone: "system",
    icon: Wrench,
    items: [
      { href: "/connectors", label: "Connectors", icon: Plug },
      { href: "/slack-workspaces", label: "Slack", icon: Slack },
      { href: "/meetings", label: "Meetings", icon: Video },
      { href: "/feature-flags", label: "Feature flags", icon: ToggleLeft },
      { href: "/gatekeeper", label: "Gatekeeper", icon: Flag },
      { href: "/scripts", label: "Scripts", icon: Terminal },
      { href: "/audit", label: "Audit log", icon: ScrollText },
      { href: "/super-users", label: "Super users", icon: ShieldCheck },
      { href: "/allowlist", label: "Allowlist", icon: Users },
      { href: "/settings", label: "Settings", icon: SlidersHorizontal },
      { href: "/config", label: "Config", icon: Settings },
      { href: "/site-shards", label: "Site shards", icon: Database },
    ],
  },
];

export type NavItem = Section & {
  group: string;
  groupKey: Tone | null;
  tone: Tone;
};

export const ALL_ITEMS: ReadonlyArray<NavItem> = [
  ...GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title ?? "", groupKey: g.key, tone: g.tone }))),
  { ...PANIC_STOP, group: "Emergency", groupKey: null, tone: "health" },
];

function matches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const i of ALL_ITEMS) {
    if (matches(pathname, i.href) && (best === null || i.href.length > best.length)) best = i.href;
  }
  return best;
}

export const DEFAULT_OPEN_GROUPS: Readonly<Record<string, boolean>> = {};

export const NAV_GROUPS_KEY = "zavi.admin.navGroups.v2";

export function parseStoredGroups(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
      if (typeof b === "boolean") out[k] = b;
    }
    return out;
  } catch {
    return {};
  }
}

export function isGroupOpen(
  key: string,
  stored: Record<string, boolean>,
  activeGroup: string | null,
): boolean {
  if (key === activeGroup) return true;
  if (key in stored) return stored[key];
  return DEFAULT_OPEN_GROUPS[key] ?? false;
}

export function groupOf(href: string | null): Tone | null {
  if (!href) return null;
  return ALL_ITEMS.find((i) => i.href === href)?.groupKey ?? null;
}

export function filterNav<T extends { label: string; group: string }>(items: ReadonlyArray<T>, query: string): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const label = item.label.toLowerCase();
    const hay = `${label} ${item.group.toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) return;
    const score = label.startsWith(terms[0]) ? 0 : terms.every((t) => label.includes(t)) ? 1 : 2;
    scored.push({ item, score, idx });
  });
  return scored.sort((a, b) => a.score - b.score || a.idx - b.idx).map((s) => s.item);
}

export const NAV_PINS_KEY = "zavi.admin.navPins";

export const DEFAULT_PINS: ReadonlyArray<string> = [
  "/errors",
  "/tenants",
  "/tenant-health",
  "/runs",
  "/revenue",
  "/costs",
  "/activation",
];

const PINNABLE_HREFS = new Set(GROUPS.filter((g) => g.title !== null).flatMap((g) => g.items.map((i) => i.href)));

export function parseStoredPins(raw: string | null): string[] {
  if (raw === null) return [...DEFAULT_PINS];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [...DEFAULT_PINS];
    const out: string[] = [];
    for (const h of v) {
      if (typeof h === "string" && PINNABLE_HREFS.has(h) && !out.includes(h)) out.push(h);
    }
    return out;
  } catch {
    return [...DEFAULT_PINS];
  }
}

export function togglePin(pins: ReadonlyArray<string>, href: string): string[] {
  if (pins.includes(href)) return pins.filter((h) => h !== href);
  return PINNABLE_HREFS.has(href) ? [...pins, href] : [...pins];
}

export function itemOf(href: string): NavItem | null {
  return ALL_ITEMS.find((i) => i.href === href) ?? null;
}

export function pinsFirst<T extends { href: string }>(items: ReadonlyArray<T>, pins: ReadonlyArray<string>): T[] {
  const pinned = pins.map((h) => items.find((i) => i.href === h)).filter((i): i is T => i !== undefined);
  return [...pinned, ...items.filter((i) => !pins.includes(i.href))];
}
