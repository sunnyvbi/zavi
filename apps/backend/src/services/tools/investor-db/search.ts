
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";
import {
  canonicalizeStages,
  canonicalizeGeography,
  canonicalizeSectors,
  isAngelTagged,
  ANGEL_NICHES,
  CANONICAL_STAGES,
  CANONICAL_GEOGRAPHIES,
} from "./vocab";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const CANDIDATE_CAP = 500;

export const investorSearchInput = z.object({
  sectors: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Sector/thesis tags to match against each investor's niches (array overlap). e.g. ['B2B SaaS','FinTech','AI'].",
    ),
  stages: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Funding stages to match against each investor's stages (array overlap). ` +
        `Allowed values: ${CANONICAL_STAGES.join(", ")}, or 'Angel' for an angel round. ` +
        `'Angel' returns angel / solo-capitalist rows first (angel_tagged: true) plus pre-seed funds ` +
        `(angel_tagged: false), which are not angel investors. ` +
        `Common variants are auto-corrected (e.g. 'Pre-Seed'/'pre seed' -> 'Pre-seed', 'seed' -> 'Seed'). ` +
        `e.g. ['Pre-seed','Seed'].`,
    ),
  check_size: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fuzzy check-size hint matched as a substring against the investor's check_buckets (e.g. '$1M', '500K', '$250K - $1M').",
    ),
  geography: z
    .string()
    .min(1)
    .optional()
    .describe(
      `A geography to match against the investor's geographies (array overlap). ` +
        `Canonical buckets: ${CANONICAL_GEOGRAPHIES.join(", ")}. ` +
        `Common variants are auto-corrected (e.g. 'US'/'United States' -> US/Canada+USA, 'UK' -> Europe). ` +
        `e.g. 'US/Canada', 'Europe'.`,
    ),
  leads_only: z
    .boolean()
    .optional()
    .describe("When true, return only investors who LEAD rounds (leads_rounds = true)."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max investors to return (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`),
});

type InvestorSearchInput = z.infer<typeof investorSearchInput>;

type InvestorRow = {
  name: string;
  title: string | null;
  primary_firm: string | null;
  check_buckets: string[] | null;
  niches: string[] | null;
  stages: string[] | null;
  leads_rounds: boolean | null;
  selected_investments: string | null;
  email: string | null;
  geographies: string[] | null;
  twitter: string | null;
  linkedin: string | null;
  bio: string | null;
  based_in: string | null;
};

const SELECT_COLS =
  "name,title,primary_firm,check_buckets,niches,stages,leads_rounds,selected_investments,email,geographies,twitter,linkedin,bio,based_in";

export const investorDbSearchTool: ToolSpec = {
  name: "investor_db_search",
  effect: "read",
  description:
    "Search the curated GLOBAL investor reference list (real VCs/angels/funds) by sector, stage, check size, " +
    "geography, and whether they lead rounds. Read-only. Returns real investor rows (name, firm, title, niches, " +
    "stages, check_buckets, leads_rounds, selected_investments, bio, contact handles). This is the PRIMARY source " +
    "of investors for the fundraising agent — tier the returned rows and ground outreach in their real fields. " +
    "All filters optional; with none set, returns lead investors first.",
  input_schema: investorSearchInput,
  async execute(_ctx, input) {
    const args = input as InvestorSearchInput;
    const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    const sb = serviceClient();

    const sectorCanon = canonicalizeSectors(args.sectors);
    const stageCanon = canonicalizeStages(args.stages);
    const geoCanon = canonicalizeGeography(args.geography);
    const ignored_filters: string[] = [
      ...sectorCanon.ignored.map((v) => `sector:${v}`),
      ...stageCanon.ignored.map((v) => `stage:${v}`),
      ...geoCanon.ignored.map((v) => `geography:${v}`),
    ];

    type Filters = {
      sectors: string[];
      stages: string[];
      geographies: string[];
      leadsOnly: boolean;
      angelOnly?: boolean;
    };
    const baseFilters: Filters = {
      sectors: sectorCanon.values,
      stages: stageCanon.values,
      geographies: geoCanon.values,
      leadsOnly: args.leads_only === true,
    };

    const runQuery = async (filters: Filters): Promise<InvestorRow[]> => {
      let q = sb.from("investor_reference").select(SELECT_COLS);
      if (filters.sectors.length > 0) q = q.overlaps("niches", filters.sectors);
      if (filters.stages.length > 0) q = q.overlaps("stages", filters.stages);
      if (filters.geographies.length > 0) q = q.overlaps("geographies", filters.geographies);
      if (filters.angelOnly) q = q.overlaps("niches", [...ANGEL_NICHES]);
      if (filters.leadsOnly) q = q.eq("leads_rounds", true);
      const { data, error } = await q
        .order("leads_rounds", { ascending: false })
        .order("name", { ascending: true })
        .limit(CANDIDATE_CAP);
      if (error) {
        throw new ExpectedToolError(
          "investor_db_query_failed",
          `investor_reference query failed: ${error.message}`,
        );
      }
      return (data ?? []) as InvestorRow[];
    };

    const angelRound = stageCanon.angel;
    const runAll = async (filters: Filters): Promise<InvestorRow[]> => {
      if (!angelRound) return runQuery(filters);
      const angels = await runQuery({ ...filters, stages: [], angelOnly: true });
      const funds = await runQuery({
        ...filters,
        stages: [...new Set([...filters.stages, "Pre-seed"])],
      });
      const seen = new Set(angels.map((r) => `${r.primary_firm ?? ""}|${r.name}`));
      return [...angels, ...funds.filter((r) => !seen.has(`${r.primary_firm ?? ""}|${r.name}`))];
    };

    let rows = await runAll(baseFilters);

    const relaxed_filters: string[] = [];
    if (rows.length === 0 && baseFilters.geographies.length > 0) {
      rows = await runAll({ ...baseFilters, geographies: [] });
      if (rows.length > 0) relaxed_filters.push("geography");
    }

    if (args.check_size) {
      const needle = args.check_size.toLowerCase();
      rows = rows.filter((r) =>
        (r.check_buckets ?? []).join("; ").toLowerCase().includes(needle),
      );
    }

    const wantSectors = new Set(sectorCanon.values.map((s) => s.toLowerCase()));
    const overlapCount = (r: InvestorRow): number => {
      if (wantSectors.size === 0) return 0;
      let n = 0;
      for (const niche of r.niches ?? []) {
        if (wantSectors.has(niche.toLowerCase())) n++;
      }
      return n;
    };
    rows.sort((a, b) => {
      if (angelRound) {
        const aa = isAngelTagged(a.niches, a.check_buckets) ? 1 : 0;
        const ab = isAngelTagged(b.niches, b.check_buckets) ? 1 : 0;
        if (aa !== ab) return ab - aa;
      }
      const oa = overlapCount(a);
      const ob = overlapCount(b);
      if (oa !== ob) return ob - oa;
      const la = a.leads_rounds ? 1 : 0;
      const lb = b.leads_rounds ? 1 : 0;
      if (la !== lb) return lb - la;
      return (a.name || "").localeCompare(b.name || "");
    });

    const investors = angelRound
      ? rows.slice(0, limit).map((r) => ({ ...r, angel_tagged: isAngelTagged(r.niches, r.check_buckets) }))
      : rows.slice(0, limit);
    return {
      ok: true,
      count: investors.length,
      truncated: rows.length > limit,
      ...(ignored_filters.length > 0 ? { ignored_filters } : {}),
      ...(relaxed_filters.length > 0 && investors.length > 0 ? { relaxed_filters } : {}),
      investors,
    };
  },
};
