
import type { StartCardDesignEvidence } from "@zavi/shared";
import { fetchPagespeed, type PagespeedResult } from "@/services/tools/growth/seo/pagespeed";
import { StageUnavailableError, rivalsWithSite, type StageContext, type StageOutcome } from "./contract";
import { designPoints, rivalDesignPoints } from "./points";
import { renderSitesOnPhone, type RenderSites } from "./render";
import { ANCHOR_SESSION_EST_USD, PAGESPEED_EST_USD, roundUsd } from "./costs";
import { designNote } from "./notes";

export const CARD_PAGESPEED_TIMEOUT_MS = 90_000;

export type DesignDeps = {
  pagespeed?: (url: string) => Promise<PagespeedResult>;
  render?: RenderSites;
};

const defaultPagespeed = (url: string) =>
  fetchPagespeed(url, { strategy: "mobile", timeoutMs: CARD_PAGESPEED_TIMEOUT_MS });

export function pagespeedScores(r: PagespeedResult | null): { performance: number; accessibility: number } | null {
  if (!r || r.kind !== "ok") return null;
  const score = (id: string) => r.categories.find((c) => c.id === id)?.score;
  const perf = score("performance");
  const a11y = score("accessibility");
  if (typeof perf !== "number" || typeof a11y !== "number") return null;
  return { performance: Math.round(perf * 100), accessibility: Math.round(a11y * 100) };
}

export async function runDesign(ctx: StageContext, deps: DesignDeps = {}): Promise<StageOutcome<StartCardDesignEvidence>> {
  const rivals = rivalsWithSite(ctx);
  const urls = [ctx.url, ...rivals.map((r) => `https://${r.domain}/`)];
  const render = deps.render ?? renderSitesOnPhone;
  const anchorConfigured = deps.render ? true : Boolean(process.env.ANCHOR_API_KEY);

  const [psi, renders] = await Promise.all([
    (deps.pagespeed ?? defaultPagespeed)(ctx.url).catch(() => null),
    render(urls).catch(() => null),
  ]);

  const cost = roundUsd(PAGESPEED_EST_USD + (anchorConfigured ? ANCHOR_SESSION_EST_USD : 0));
  const evidence: StartCardDesignEvidence = {
    pagespeed: pagespeedScores(psi),
    render: renders?.[0] ?? null,
    rivals: rivals.map((r, i) => {
      const rr = renders?.[i + 1] ?? null;
      return { domain: r.domain, render: rr, points: rivalDesignPoints(rr) };
    }),
  };
  const points = designPoints(evidence);
  if (points === null) {
    const reason = psi?.kind === "not_configured" && !anchorConfigured ? "vendor_not_configured" : "not_measured";
    throw new StageUnavailableError(reason, cost);
  }
  evidence.note = designNote(evidence);
  return { evidence, points, max_points: 20, cost_usd: cost };
}
