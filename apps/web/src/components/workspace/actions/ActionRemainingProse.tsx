import { cn } from "@/lib/cn";
import { RichText } from "./CopyBlocks";

export function ActionRemainingProse({ text, names, advertising }: { text: string; names: string[]; advertising: boolean }) {
  if (!text) return null;
  return <div data-testid="action-rest" className={cn("leading-relaxed text-ink [overflow-wrap:anywhere]", advertising ? "text-ad-body" : "text-sm")}><RichText text={text} names={names} preWrap /></div>;
}
