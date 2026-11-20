import { ScrollText } from "lucide-react";

export function RulesCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
      <div className="flex items-start gap-3">
        <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-[#8a8a8a]" aria-hidden />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
