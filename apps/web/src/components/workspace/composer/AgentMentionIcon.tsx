
import { Bot, CodeXml, Landmark, Scale } from "lucide-react";

const MASCOT_SRC = "/mascots/video/zavi-still.webp";

const AGENT_GLYPHS: Record<string, typeof Bot> = {
  engineer: CodeXml,
  fundraising: Landmark,
  "supply-demand-balancer": Scale,
};

export function AgentMentionIcon({ slug }: { slug: string }) {
  if (slug === "cgo")
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#CCFBF1] ring-[1.5px] ring-[#14B8A6] [html.dark_&]:bg-[#134E4A] [html.dark_&]:ring-[#2DD4BF]">
        {/* eslint-disable-next-line @next/next/no-img-element -- a 20px static still */}
        <img src={MASCOT_SRC} alt="" width={20} height={20} className="h-full w-full object-cover" />
      </span>
    );
  const Glyph = AGENT_GLYPHS[slug] ?? Bot;
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-inkMuted">
      <Glyph className="h-3 w-3" aria-hidden />
    </span>
  );
}
