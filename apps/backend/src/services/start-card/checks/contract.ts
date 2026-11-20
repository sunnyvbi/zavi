
import type { StartCardLocale, StartCardParts, StartCardProfileEvidence } from "@zavi/shared";

export class StageUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly cost_usd: number = 0,
  ) {
    super(`stage unavailable: ${reason}`);
    this.name = "StageUnavailableError";
  }
}

export type StageContext = {
  card_id: string;
  domain: string;
  url: string;
  profile: StartCardProfileEvidence | null;
  parts: StartCardParts;
  visitor_country?: StartCardLocale | null;
  funding_tenant_id?: string | null;
};

export type StageOutcome<E> = {
  evidence: E;
  points?: number;
  max_points?: number;
  cost_usd: number;
};

export function rivalsWithSite(ctx: StageContext): { name: string; domain: string }[] {
  return (ctx.profile?.rivals ?? [])
    .filter((r): r is typeof r & { domain: string } => !r.no_site && !!r.domain && r.domain !== ctx.domain)
    .map((r) => ({ name: r.name, domain: r.domain }));
}
