import { Badge } from "@/components/ui/Badge";
import type { HistoryTone } from "./historyPresentation";

export function HistoryStatus({ label, tone }: { label: string; tone: HistoryTone }) {
  return <Badge tone={tone} className="max-w-full gap-1.5 px-2.5 py-1 text-detail leading-5">
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
    <span className="break-words">{label}</span>
  </Badge>;
}
