
import type { MarketFitVerdict } from "./constants";

export type ParsedVerdict = { verdict: MarketFitVerdict; reason: string };

export function parseMarketFitVerdict(text: string | null | undefined): ParsedVerdict | null {
  if (!text || typeof text !== "string") return null;
  const vm = text.match(/MarketFitVerdict\s*[:=]\s*(APPROVE|BOUNCE)/i);
  if (!vm) return null;
  const verdict: MarketFitVerdict =
    vm[1].toUpperCase() === "APPROVE" ? "approve" : "bounce";
  const rm = text.match(/(?:Bounce\s*reason|Reason|Rationale)\s*[:=]\s*([^\n]+)/i);
  const reason = (rm?.[1] ?? "").trim().slice(0, 500);
  return { verdict, reason };
}
