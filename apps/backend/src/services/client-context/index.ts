import { loadChannels } from "./channels";
import { cachedSection } from "./cache";
import { resolveWindows } from "./windows";
import {
  loadAnalytics,
  loadCompany,
  loadCompetitors,
  loadGoals,
} from "./sections";
import type {
  AnalyticsSection,
  ChannelsSection,
  ClientContext,
  CompanySection,
  CompetitorsSection,
  GoalsSection,
  Section,
} from "./types";

export * from "./types";
export { resolveWindows } from "./windows";
export { invalidateClientContext, clearClientContextCache } from "./cache";

export const CONTEXT_SECTIONS = ["company", "goals", "channels", "analytics", "competitors"] as const;
export type ContextSectionKey = (typeof CONTEXT_SECTIONS)[number];

export type ClientContextOptions = {
  now?: Date;
  windowDays?: number;
  fresh?: boolean;
};

export type PartialClientContext = Pick<
  ClientContext,
  "tenant_id" | "generated_at" | "availability" | "source_timestamps"
> &
  Partial<Pick<ClientContext, ContextSectionKey>>;

const DEFAULT_WINDOW_DAYS = 30;
const MINUTE = 60_000;
const TTL_MS: Record<ContextSectionKey, number> = {
  company: MINUTE,
  goals: MINUTE,
  competitors: MINUTE,
  channels: 5 * MINUTE,
  analytics: 5 * MINUTE,
};
const LABEL: Record<ContextSectionKey, string> = {
  company: "Company",
  goals: "Goals",
  channels: "Growth channels",
  analytics: "Analytics",
  competitors: "Competitors",
};

type Window = { since: string; until: string };

function emptyCompany(tenant_id: string): CompanySection {
  return {
    tenant_id,
    name: tenant_id.slice(0, 8),
    slug: "",
    domain: null,
    facts: [],
    description: null,
    description_updated_at: null,
    connected_sources: [],
    social_profiles: [],
    profile: [],
    icp: [],
    business_model: [],
    unrecorded_count: 0,
  };
}

function emptyGoals(): GoalsSection {
  return { goals: [], summary: { active: 0, on_track: 0, needs_attention: 0, average_progress: null } };
}

function emptyChannels(window: Window): ChannelsSection {
  return { paid: [], organic: [], totals: { paid: null, organic: null }, window };
}

function emptyAnalytics(window: Window): AnalyticsSection {
  return { metrics: [], trends: { points: [], channel_points: [], sources: [], window }, channels: null };
}

function emptyCompetitors(): CompetitorsSection {
  return { competitors: [], recommended_moves: [], week_bucket: null };
}

async function guarded<T>(label: string, fallback: T, work: () => Promise<Section<T>>): Promise<Section<T>> {
  try {
    return await work();
  } catch (e) {
    return {
      status: "not_connected",
      detail: `${label} could not be loaded: ${(e as Error)?.message ?? "unknown error"}`,
      data: fallback,
      source_updated_at: null,
    };
  }
}

type Loaders = { [K in ContextSectionKey]: () => Promise<ClientContext[K]> };

function loaders(tenant_id: string, now: Date, windowDays: number, fresh: boolean): Loaders {
  const { window } = resolveWindows(now, windowDays);
  const cached = <K extends ContextSectionKey>(key: K, work: () => Promise<ClientContext[K]>) =>
    cachedSection(`${tenant_id}:${key}:${windowDays}`, TTL_MS[key], fresh, work);
  return {
    company: () =>
      cached("company", () => guarded(LABEL.company, emptyCompany(tenant_id), () => loadCompany(tenant_id))),
    goals: () => cached("goals", () => guarded(LABEL.goals, emptyGoals(), () => loadGoals(tenant_id, now))),
    channels: () =>
      cached("channels", () =>
        guarded(LABEL.channels, emptyChannels(window), () => loadChannels(tenant_id, window)),
      ),
    analytics: () =>
      cached("analytics", () =>
        guarded(LABEL.analytics, emptyAnalytics(window), () => loadAnalytics(tenant_id, window, null)),
      ),
    competitors: () =>
      cached("competitors", () =>
        guarded(LABEL.competitors, emptyCompetitors(), () => loadCompetitors(tenant_id)),
      ),
  };
}

export async function loadClientContextSections(
  tenant_id: string,
  sections: readonly ContextSectionKey[],
  opts: ClientContextOptions = {},
): Promise<PartialClientContext> {
  const now = opts.now ?? new Date();
  const load = loaders(tenant_id, now, opts.windowDays ?? DEFAULT_WINDOW_DAYS, opts.fresh ?? false);
  const keys = [...new Set(sections)];
  const loaded = await Promise.all(keys.map((key) => load[key]()));

  const context: PartialClientContext = {
    tenant_id,
    generated_at: now.toISOString(),
    availability: [],
    source_timestamps: {},
  };
  keys.forEach((key, index) => {
    const section = loaded[index] as Section<unknown>;
    (context as Record<string, unknown>)[key] = section;
    context.source_timestamps[key] = section.source_updated_at;
  });
  return context;
}

export async function loadClientContext(
  tenant_id: string,
  opts: ClientContextOptions = {},
): Promise<ClientContext> {
  return (await loadClientContextSections(tenant_id, CONTEXT_SECTIONS, opts)) as ClientContext;
}
