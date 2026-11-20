import type { DashboardBuilder } from "./_contract";

type ResearchTemplate =
  | "customer-intel"
  | "competitor-teardown"
  | "landscape"
  | "freeform"
  | string;

type ValidationTier = "validated" | "inferred" | "assumption" | "high-risk";

type ArtifactChip = {
  id: string;
  filename: string;
};

type ValidationMix = {
  validated: number;
  inferred: number;
  assumption: number;
  high_risk: number;
  total: number;
};

type ParsedReportFull = {
  kind: "report";
  title: string;
  template: ResearchTemplate;
  subtitle: string | null;
  query: string | null;
  blocks: unknown[];
  lenses: unknown[];
  sources: unknown[];
  validation: unknown[];
  failed_lenses: string[];
  generated_at: string | null;
};

type ClarificationQuestion = {
  question: string;
  why: string;
};

type RequestRow = {
  run_id: string;
  status: "answered" | "running" | "needs_you";
  query: string;
  template: ResearchTemplate;
  generated_at: string | null;
  sources_count: number;
  validation_mix: ValidationMix;
  has_pdf: boolean;
  artifact: ArtifactChip | null;
  report: ParsedReportFull | null;
  questions: ClarificationQuestion[] | null;
};

type ParsedEnvelope = {
  kind?: string;
  title?: unknown;
  template?: unknown;
  subtitle?: unknown;
  query?: unknown;
  blocks?: unknown;
  lenses?: unknown;
  sources?: unknown;
  validation?: unknown;
  failed_lenses?: unknown;
  generated_at?: unknown;
  questions?: unknown;
};

type AgentRunRow = {
  id: string;
  status: string | null;
  enqueued_at: string | null;
  parsed: unknown;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  filename: string;
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function templateLabel(t: ResearchTemplate): string {
  switch (t) {
    case "customer-intel":
      return "Customer intel";
    case "competitor-teardown":
      return "Competitor teardown";
    case "landscape":
      return "Landscape";
    case "freeform":
      return "Freeform";
    default:
      return String(t || "Report").replace(/[-_]/g, " ");
  }
}

function validationMix(validation: unknown): { mix: ValidationMix; weak: number } {
  const mix: ValidationMix = {
    validated: 0,
    inferred: 0,
    assumption: 0,
    high_risk: 0,
    total: 0,
  };
  let weak = 0;
  if (Array.isArray(validation)) {
    for (const chip of validation) {
      const tier = (chip as { tier?: unknown })?.tier;
      if (typeof tier !== "string") continue;
      switch (tier as ValidationTier) {
        case "validated":
          mix.validated += 1;
          mix.total += 1;
          break;
        case "inferred":
          mix.inferred += 1;
          mix.total += 1;
          break;
        case "assumption":
          mix.assumption += 1;
          mix.total += 1;
          weak += 1;
          break;
        case "high-risk":
          mix.high_risk += 1;
          mix.total += 1;
          weak += 1;
          break;
        default:
          break;
      }
    }
  }
  return { mix, weak };
}

export const build: DashboardBuilder = async (c) => {
  let runs: AgentRunRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, status, enqueued_at, parsed")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "research")
      .in("status", ["success", "running", "queued", "error"])
      .order("enqueued_at", { ascending: false })
      .limit(40);
    if (error) throw error;
    runs = (data ?? []) as AgentRunRow[];
  } catch {
    return { requests: [] };
  }

  type Enriched = {
    row: RequestRow;
    generatedAtMs: number | null;
    thinSourcing: boolean;
  };
  const enriched: Enriched[] = [];

  for (const r of runs) {
    const parsed = (r.parsed ?? null) as ParsedEnvelope | null;
    const runStatus = asString(r.status) ?? "";

    if (parsed && parsed.kind === "clarification") {
      const questions: ClarificationQuestion[] = Array.isArray(parsed.questions)
        ? (parsed.questions as unknown[])
            .map((q) => {
              const question = asString((q as { question?: unknown })?.question);
              const why = asString((q as { why?: unknown })?.why);
              return question ? { question, why: why ?? "" } : null;
            })
            .filter((q): q is ClarificationQuestion => q !== null)
        : [];
      enriched.push({
        generatedAtMs: null,
        thinSourcing: false,
        row: {
          run_id: r.id,
          status: "needs_you",
          query:
            asString(parsed.query) ??
            asString(parsed.title) ??
            "Clarification needed",
          template: (asString(parsed.template) ?? "freeform") as ResearchTemplate,
          generated_at: r.enqueued_at,
          sources_count: 0,
          validation_mix: {
            validated: 0,
            inferred: 0,
            assumption: 0,
            high_risk: 0,
            total: 0,
          },
          has_pdf: false,
          artifact: null,
          report: null,
          questions,
        },
      });
      continue;
    }

    if (runStatus === "success" && parsed && parsed.kind === "report") {
      const title = asString(parsed.title) ?? "Untitled report";
      const template = (asString(parsed.template) ?? "freeform") as ResearchTemplate;
      const query = asString(parsed.query) ?? title;
      const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
      const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
      const lenses = Array.isArray(parsed.lenses) ? parsed.lenses : [];
      const validation = Array.isArray(parsed.validation) ? parsed.validation : [];
      const failedLenses = Array.isArray(parsed.failed_lenses)
        ? (parsed.failed_lenses as unknown[]).filter(
            (l): l is string => typeof l === "string",
          )
        : [];

      const generatedAtIso = asString(parsed.generated_at) ?? r.enqueued_at ?? null;
      const generatedAtMs = generatedAtIso
        ? (() => {
            const t = new Date(generatedAtIso).getTime();
            return Number.isNaN(t) ? null : t;
          })()
        : null;

      const { mix, weak } = validationMix(validation);
      const thinSourcing =
        failedLenses.length > 0 || (mix.total > 0 && weak / mix.total > 0.5);

      enriched.push({
        generatedAtMs,
        thinSourcing,
        row: {
          run_id: r.id,
          status: "answered",
          query,
          template,
          generated_at: generatedAtIso,
          sources_count: sources.length,
          validation_mix: mix,
          has_pdf: false,
          artifact: null,
          report: {
            kind: "report",
            title,
            template,
            subtitle: asString(parsed.subtitle),
            query,
            blocks,
            lenses,
            sources,
            validation,
            failed_lenses: failedLenses,
            generated_at: generatedAtIso,
          },
          questions: null,
        },
      });
      continue;
    }

    if (runStatus === "running" || runStatus === "queued") {
      const query =
        (parsed && asString(parsed.query)) ?? "Researching…";
      enriched.push({
        generatedAtMs: null,
        thinSourcing: false,
        row: {
          run_id: r.id,
          status: "running",
          query,
          template: (parsed && (asString(parsed.template) as ResearchTemplate)) ??
            "freeform",
          generated_at: r.enqueued_at,
          sources_count: 0,
          validation_mix: {
            validated: 0,
            inferred: 0,
            assumption: 0,
            high_risk: 0,
            total: 0,
          },
          has_pdf: false,
          artifact: null,
          report: null,
          questions: null,
        },
      });
      continue;
    }

  }

  const answeredRunIds = enriched
    .filter((e) => e.row.status === "answered")
    .map((e) => e.row.run_id);
  if (answeredRunIds.length > 0) {
    try {
      const { data, error } = await c.sb
        .from("run_artifacts")
        .select("id, run_id, filename")
        .eq("tenant_id", c.tenantId)
        .in("run_id", answeredRunIds);
      if (!error && Array.isArray(data)) {
        const byRun = new Map<string, ArtifactRow>();
        for (const a of data as ArtifactRow[]) {
          if (!byRun.has(a.run_id)) byRun.set(a.run_id, a);
        }
        for (const e of enriched) {
          const art = byRun.get(e.row.run_id);
          if (art) {
            e.row.has_pdf = true;
            e.row.artifact = { id: art.id, filename: art.filename };
          }
        }
      }
    } catch {
    }
  }

  const requests = enriched.map((e) => e.row);
  const answered = enriched.filter((e) => e.row.status === "answered");

  const reportsProduced = answered.length;
  const sourcesCited = answered.reduce((s, e) => s + e.row.sources_count, 0);
  const pdfsGenerated = answered.filter((e) => e.row.has_pdf).length;
  const lastResearchedMs = answered.reduce<number | null>((max, e) => {
    if (e.generatedAtMs == null) return max;
    return max == null ? e.generatedAtMs : Math.max(max, e.generatedAtMs);
  }, null);
  const lastResearchedIso =
    lastResearchedMs != null ? new Date(lastResearchedMs).toISOString() : null;

  const TIME_SENSITIVE: ReadonlySet<string> = new Set([
    "competitor-teardown",
    "landscape",
  ]);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const attention: Array<{
    severity: "high" | "warn";
    title: string;
    detail: string;
    ask: string;
  }> = [];
  const now = Date.now();

  const staleStale = answered
    .filter(
      (e) =>
        TIME_SENSITIVE.has(String(e.row.template)) &&
        e.generatedAtMs != null &&
        now - e.generatedAtMs > THIRTY_DAYS_MS,
    )
    .sort((a, b) => (a.generatedAtMs ?? 0) - (b.generatedAtMs ?? 0))[0];
  if (staleStale) {
    const t = staleStale.row.report?.title ?? staleStale.row.query;
    attention.push({
      severity: "warn",
      title: `"${t}" is over a month old`,
      detail: `This ${templateLabel(staleStale.row.template)} scan is more than 30 days old — pricing, positioning, and the competitive set may have moved since.`,
      ask: `Re-run the "${t}" scan — it's a month old and the market may have moved.`,
    });
  }

  const thin = answered.find((e) => e.thinSourcing);
  if (thin) {
    const t = thin.row.report?.title ?? thin.row.query;
    attention.push({
      severity: "warn",
      title: `"${t}" had thin sourcing`,
      detail:
        "Most of this report's claims were tagged assumption / high-risk, or a research lens failed — the conclusions rest on weak evidence.",
      ask: `The "${t}" report had thin sourcing — dig deeper with primary sources.`,
    });
  }

  return {
    kpis: {
      reports_produced: reportsProduced,
      sources_cited: sourcesCited,
      pdfs_generated: pdfsGenerated,
      last_researched: lastResearchedIso,
    },
    requests,
    attention,
  };
};
