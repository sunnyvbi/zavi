import type { DayKind, PublicDay } from "@/lib/marketing/liveUpcar";
import { usd } from "./format";

export const KIND_LABEL: Record<DayKind, string> = {
  PLAN: "Plan",
  CHANGE: "Change",
  WORK: "Groundwork",
  WIN: "Worked",
  LOSS: "Flopped",
  HUMAN: "A person did this",
  NOT_AVAILABLE: "Couldn't do it",
};

export function budgetLine(b: PublicDay["budget"][number]): string {
  if (b.from_usd === null || b.to_usd === null) return "$•••";
  if (b.from_usd === 0) return `${usd(b.to_usd)}/day, new`;
  if (b.to_usd === 0) return `${usd(b.from_usd)}/day, stopped`;
  const d = b.to_usd - b.from_usd;
  return `${usd(b.from_usd)} → ${usd(b.to_usd)}/day (${d > 0 ? "+" : "-"}${usd(Math.abs(d))})`;
}

export function netMove(e: PublicDay): string {
  if (!e.budget.length) return "no money moved";
  if (e.budget.some((b) => b.from_usd === null || b.to_usd === null)) return "budget changed";
  const n = e.budget.reduce((s, b) => s + ((b.to_usd ?? 0) - (b.from_usd ?? 0)), 0);
  if (n === 0) return `${usd(Math.abs((e.budget[0].to_usd ?? 0) - (e.budget[0].from_usd ?? 0)))}/day moved`;
  return `${n > 0 ? "+" : "-"}${usd(Math.abs(n))}/day`;
}

export const dayPath = (slug: string, n: number) => `/live/${slug}/day/${n}`;
