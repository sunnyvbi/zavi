import type { ReactNode } from "react";
import { Info, MapPin, Send, Wallet } from "lucide-react";

export function ActionCardFacts({ description, cost, provenance, destination, prefix = "action" }: { description: ReactNode; cost?: ReactNode; provenance?: ReactNode; destination?: ReactNode; prefix?: string }) {
  const rows = [
    { label: "What it is", icon: Info, value: description, id: "description" },
    { label: "Cost", icon: Wallet, value: cost, id: "cost" },
    { label: "Comes from", icon: MapPin, value: provenance, id: "provenance" },
    { label: "Goes to", icon: Send, value: destination, id: "destination" },
  ];
  return <dl className="mt-5 flex flex-col gap-4 rounded-2xl border border-rule bg-creamDeep p-5 sm:gap-3">{rows.filter((row) => row.value).map(({ label, icon: Icon, value, id }) => <div key={id} className="grid min-w-0 grid-cols-1 items-start gap-1 sm:grid-cols-ad-facts sm:gap-3"><dt className="flex items-center gap-2 text-sm font-semibold leading-6 text-inkMuted"><Icon className="size-4 shrink-0 text-inkLight" aria-hidden />{label}</dt><dd data-testid={`${prefix}-${id}`} className="min-w-0 space-y-2 break-words text-ad-body font-medium text-inkSoft">{value}</dd></div>)}</dl>;
}
