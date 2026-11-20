"use client";

import { useState, type ReactNode } from "react";
import {
  BarChart3,
  Binoculars,
  CalendarRange,
  ChevronDown,
  Crosshair,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  PenLine,
  Presentation,
  Sprout,
  Swords,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { TypewriterHeading } from "./TypewriterHeading";
import { ConnectRows } from "./ConnectRows";
import { CHIP_CLASS, ChipIcon } from "./Chip";
import { MarqueeRow } from "./MarqueeRow";
import { ZaviMascot } from "@/components/ZaviMascot";
import { useIsCompact } from "@/lib/responsive";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";

export type WorkspaceMode = "build" | "grow";

export type SuggestionChip = {
  label: string;
  prompt: string;
  icon: LucideIcon;
  color: string;
};

export const WORKSPACE_MODE_SUGGESTION_CHIPS: Record<
  WorkspaceMode,
  SuggestionChip[]
> = {
  build: [
    {
      label: "Landing page",
      prompt: "A launch-ready landing page",
      icon: LayoutTemplate,
      color: "text-blue-400",
    },
    { label: "Customer portal", prompt: "A customer portal", icon: Users, color: "text-purple-400" },
    {
      label: "Analytics dashboard",
      prompt: "An analytics dashboard",
      icon: BarChart3,
      color: "text-emerald-400",
    },
  ],
  grow: [
    {
      label: "Plan my next month",
      prompt: "What's my 30 day marketing strategy?",
      icon: CalendarRange,
      color: "text-blue-400",
    },
    {
      label: "Find my target customer",
      prompt: "Who's my target customer and what pain points should I lead with?",
      icon: Target,
      color: "text-rose-400",
    },
    {
      label: "My competitors",
      prompt: "Show me the competitors I'm tracking",
      icon: Swords,
      color: "text-orange-400",
    },
    {
      label: "Position my product",
      prompt: "How do you think we should position our product?",
      icon: Crosshair,
      color: "text-purple-400",
    },
    {
      label: "Write a one-liner",
      prompt: "Write me a one-liner that sells my product better",
      icon: PenLine,
      color: "text-amber-400",
    },
    {
      label: "Grow organic traffic",
      prompt: "How can we grow our organic traffic in the next 90 days?",
      icon: Sprout,
      color: "text-emerald-400",
    },
  ],
};

export const MAKE_SUGGESTION_CHIPS: SuggestionChip[] = [
  {
    label: "Design social posts",
    prompt: "Design a set of Instagram posts for my product",
    icon: ImageIcon,
    color: "text-fuchsia-400",
  },
  {
    label: "Make a deck",
    prompt: "Make me a short deck that explains what we do",
    icon: Presentation,
    color: "text-sky-400",
  },
  {
    label: "Write a blog post",
    prompt: "Write a blog post that could rank for what my customers search",
    icon: FileText,
    color: "text-emerald-400",
  },
  {
    label: "Size up a competitor",
    prompt: "Pick my closest competitor and tell me where they beat me",
    icon: Binoculars,
    color: "text-amber-400",
  },
];

export const WORKSPACE_MODE_SUGGESTIONS: Record<WorkspaceMode, string[]> = {
  build: WORKSPACE_MODE_SUGGESTION_CHIPS.build.map((chip) => chip.prompt),
  grow: WORKSPACE_MODE_SUGGESTION_CHIPS.grow.map((chip) => chip.prompt),
};

export function SuggestionChips({
  items,
  onPick,
}: {
  items: SuggestionChip[];
  onPick: (prompt: string) => void;
}) {
  const compact = useIsCompact();
  const chips = items.map(({ label, prompt, icon: Icon, color }) => (
    <button
      key={prompt}
      type="button"
      onClick={() => onPick(prompt)}
      aria-label={prompt}
      title={prompt}
      className={CHIP_CLASS}
    >
      <ChipIcon>
        <Icon className={`h-4 w-4 compact:h-[18px] compact:w-[18px] ${color}`} aria-hidden="true" />
      </ChipIcon>
      {label}
    </button>
  ));
  if (compact) return <CompactSuggestionChips>{chips}</CompactSuggestionChips>;
  return <MarqueeRow>{chips}</MarqueeRow>;
}

function CompactSuggestionChips({ children }: { children: ReactNode }) {
  const wrapOn = useBuildSessions().uiFlags?.chipsWrapMobile === true;
  if (wrapOn) {
    return (
      <div
        data-testid="suggestion-chips-wrap"
        className="flex w-full flex-wrap justify-center gap-2 py-1 [&>button]:gap-1.5 [&>button]:py-1.5 [&>button]:pl-1.5 [&>button]:pr-3.5 [&>button]:text-[14px]"
      >
        {children}
      </div>
    );
  }
  return <MarqueeRow>{children}</MarqueeRow>;
}

export function ZaviWelcome({ mode }: { mode: WorkspaceMode }) {
  return (
    <div className="text-center">
      <TypewriterHeading
        key={mode}
        mode={mode}
        className="text-[27px] font-medium tracking-[-0.025em] text-ink"
      />
    </div>
  );
}

export function WorkspaceModeWelcome({
  mode,
  composer,
  beforeComposer,
  nextTiles,
  foldIdeas = false,
  foldConnect = false,
  onPickSuggestion,
  suggestions,
  afterSuggestions,
  afterComposer,
}: {
  mode: WorkspaceMode;
  composer: ReactNode;
  beforeComposer?: ReactNode;
  afterSuggestions?: ReactNode;
  afterComposer?: ReactNode;
  nextTiles?: ReactNode;
  foldIdeas?: boolean;
  foldConnect?: boolean;
  onPickSuggestion: (suggestion: string) => void;
  suggestions?: SuggestionChip[];
}) {
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [appsAvailable, setAppsAvailable] = useState(false);
  const showIdeas = !foldIdeas || ideasOpen;
  const showApps = !foldConnect || appsOpen;
  const ideasLink = foldIdeas;
  const appsLink = foldConnect && appsAvailable;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-5 compact:pb-3">
      <div
        className={
          afterSuggestions
            ? "mx-auto flex w-full max-w-[680px] flex-1 flex-col items-center justify-start pb-10 pt-[156px] compact:pb-4 compact:pt-6"
            : "mx-auto flex w-full max-w-[680px] flex-1 flex-col items-center justify-center py-10 compact:py-4"
        }
      >
        {}
        <div className="relative mb-5">
          <div className="pointer-events-none absolute inset-x-0 -top-[132px] flex justify-center compact:hidden">
            <div className="pointer-events-auto">
              <ZaviMascot size={120} />
            </div>
          </div>
          <ZaviWelcome mode={mode} />
        </div>
        {beforeComposer}
        {mode === "grow" && nextTiles}
        <div className="w-full">{composer}</div>
        {afterComposer}
        {showIdeas && (
          <div className="mt-3 w-full">
            <SuggestionChips
              items={suggestions ?? WORKSPACE_MODE_SUGGESTION_CHIPS[mode]}
              onPick={onPickSuggestion}
            />
          </div>
        )}
        {}
        {mode === "grow" && showIdeas && (
          <div className="mt-2 w-full">
            <SuggestionChips items={MAKE_SUGGESTION_CHIPS} onPick={onPickSuggestion} />
          </div>
        )}
        {afterSuggestions}
        {}
        {(ideasLink || appsLink) && (
          <div className="mt-3 flex items-center justify-center gap-5">
            {ideasLink && (
              <FoldLink open={ideasOpen} onToggle={() => setIdeasOpen((v) => !v)}>
                {ideasOpen ? "Fewer ideas" : "More ideas"}
              </FoldLink>
            )}
            {appsLink && (
              <FoldLink open={appsOpen} onToggle={() => setAppsOpen((v) => !v)}>
                {appsOpen ? "Hide apps" : "Connect apps"}
              </FoldLink>
            )}
          </div>
        )}
        <div className={showApps ? "mt-4 w-full" : "w-full"}>
          <ConnectRows hidden={!showApps} onAvailability={setAppsAvailable} />
        </div>
      </div>
    </div>
  );
}

function FoldLink({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex min-h-[44px] items-center gap-1 rounded-full px-2 text-[14px] text-inkMuted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
    >
      {children}
      <ChevronDown
        className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}
