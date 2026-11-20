
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

export const GEO_FINDING_CODES: ReadonlySet<string> = new Set([
  "ai_crawler_blocked",
  "ai_crawler_partly_blocked",
  "content_stale",
  "geo_not_server_rendered",
  "headings_not_questions",
  "no_author_signal",
  "no_lead_passage",
  "no_schema_server_rendered",
  "no_specific_figures",
  "no_visible_dates",
]);

export type ReadinessRead = {
  status: string;
  fetched_at: string;
  findings: { code: string; urls: string[] }[];
  pages: { url: string }[];
};

export type OpenGeoCard = { id: string; proposed_at: string; evidence: string[] };

const READINESS_LINE = /^\s*growth_{1,2}geo_readiness\s*:/i;

function pathOf(raw: string): string | null {
  const s = raw.replace(/[),.;:'"\]]+$/, "");
  let p: string;
  if (/^https?:\/\//i.test(s)) {
    try {
      p = new URL(s).pathname;
    } catch {
      return null;
    }
  } else if (s.startsWith("/")) {
    p = s.split(/[?#]/)[0];
  } else {
    return null;
  }
  return p.length > 1 ? p.replace(/\/+$/, "") : "/";
}

export function readinessCitations(evidence: string[]): { codes: string[]; paths: string[] }[] {
  const out: { codes: string[]; paths: string[] }[] = [];
  for (const line of evidence) {
    if (typeof line !== "string" || !READINESS_LINE.test(line)) continue;
    const rest = line.replace(READINESS_LINE, "");
    const codes = [...new Set((rest.match(/[a-z]+(?:_[a-z]+)+/g) ?? []).filter((t) => GEO_FINDING_CODES.has(t)))];
    if (codes.length === 0) continue;
    const paths = [
      ...new Set(
        (rest.match(/(?:https?:\/\/\S+|(?<=^|[\s(])\/[^\s,;)]*)/g) ?? [])
          .map(pathOf)
          .filter((p): p is string => p !== null),
      ),
    ];
    out.push({ codes, paths });
  }
  return out;
}

export function clearedCardIds(cards: OpenGeoCard[], read: ReadinessRead): string[] {
  if (read.status !== "ok" || read.pages.length === 0) return [];
  const readAt = Date.parse(read.fetched_at);
  if (!Number.isFinite(readAt)) return [];
  const fetched = new Set(read.pages.map((p) => pathOf(p.url)).filter((p): p is string => p !== null));
  const flagged = (code: string, path: string | null) =>
    read.findings.some(
      (f) => f.code === code && (path === null || f.urls.some((u) => pathOf(u) === path)),
    );
  return cards
    .filter((card) => {
      const proposed = Date.parse(card.proposed_at);
      if (!Number.isFinite(proposed) || proposed >= readAt) return false;
      const cites = readinessCitations(card.evidence);
      if (cites.length === 0) return false;
      return cites.every(({ codes, paths }) =>
        codes.every((code) =>
          paths.length === 0
            ? !flagged(code, null)
            : paths.every((path) => fetched.has(path) && !flagged(code, path)),
        ),
      );
    })
    .map((card) => card.id);
}

export type RetireDeps = {
  openCards: (tenantId: string) => Promise<OpenGeoCard[]>;
  retire: (tenantId: string, ids: string[], readAt: string) => Promise<string[]>;
};

const DEFAULT_DEPS: RetireDeps = {
  openCards: async (tenantId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("id, proposed_at, evidence:body->step->evidence")
      .eq("channel_slug", "geo")
      .eq("status", "pending")
      .is("exec_class", null)
      .limit(100);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; proposed_at: string; evidence: unknown }[]).map((r) => ({
      id: r.id,
      proposed_at: r.proposed_at,
      evidence: Array.isArray(r.evidence) ? r.evidence.filter((e): e is string => typeof e === "string") : [],
    }));
  },
  retire: async (tenantId, ids, readAt) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "retire_cleared_geo_cards", {
      p_tenant_id: tenantId,
      p_action_ids: ids,
      p_read_at: readAt,
    });
    if (error) throw new Error(error.message);
    const stale = (data as { stale?: unknown } | null)?.stale;
    return Array.isArray(stale) ? stale.filter((x): x is string => typeof x === "string") : [];
  },
};

export async function retireClearedGeoCards(
  tenantId: string,
  read: ReadinessRead,
  deps: Partial<RetireDeps> = {},
): Promise<string[]> {
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    if (read.status !== "ok") return [];
    const ids = clearedCardIds(await d.openCards(tenantId), read);
    if (ids.length === 0) return [];
    const stale = await d.retire(tenantId, ids, read.fetched_at);
    if (stale.length > 0) {
      void logEvent({
        level: "info",
        source: "geo.retire_cleared_cards",
        code: "geo.cards_retired",
        message: `retired ${stale.length} GEO card(s) the site read of ${read.fetched_at} contradicts`,
        tenant_id: tenantId,
      });
    }
    return stale;
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "geo.retire_cleared_cards",
      code: "geo.cards_retire_failed",
      message: (e as Error).message.slice(0, 500),
      tenant_id: tenantId,
    });
    return [];
  }
}
