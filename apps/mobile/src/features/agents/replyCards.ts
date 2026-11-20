import {
  SOURCES_HEADERS,
  parseConnectorRequest,
  splitSources,
  type ConnectorRequest,
} from "@zavi/shared";
import { parseCustomAgentCard, type CustomAgentCardData } from "../agentBuilder/logic";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export function readSuggestions(meta: unknown): string[] {
  if (!isObj(meta) || !Array.isArray(meta.suggestions)) return [];
  return meta.suggestions
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 5);
}

export function readEnvelope(meta: unknown): Obj | null {
  return isObj(meta) && isObj(meta.envelope) ? meta.envelope : null;
}

export function readFromAgentSlug(meta: unknown): string | null {
  return isObj(meta) ? str(meta.from_agent_slug) : null;
}

export type BuildConfirm = {
  nonce: string;
  target: string;
  est_credits: number;
  est_usd: number;
  expires_at: string;
  status?: "started" | "replaced";
  run_id?: string | null;
};

export function parseBuildConfirm(raw: unknown): BuildConfirm | null {
  if (!isObj(raw)) return null;
  const nonce = str(raw.nonce);
  if (!nonce || typeof raw.target !== "string") return null;
  if (typeof raw.est_credits !== "number" || typeof raw.est_usd !== "number") return null;
  if (typeof raw.expires_at !== "string") return null;
  return {
    nonce,
    target: raw.target,
    est_credits: raw.est_credits,
    est_usd: raw.est_usd,
    expires_at: raw.expires_at,
    ...(raw.status === "started" || raw.status === "replaced" ? { status: raw.status } : {}),
    ...(typeof raw.run_id === "string" ? { run_id: raw.run_id } : {}),
  };
}

export function buildEstimateLine(c: Pick<BuildConfirm, "est_credits" | "est_usd">): string {
  return c.est_credits === 0
    ? "Free: this is your workspace's first build."
    : `About ${c.est_credits.toLocaleString("en-US")} credits (~$${c.est_usd.toFixed(2)}).`;
}

export type BuildStartOutcome =
  | { phase: "started"; runId: string | null }
  | { phase: "out_of_credits" }
  | { phase: "expired" }
  | { phase: "failed"; error: string };

export function buildStartOutcome(res: {
  status: number;
  body: { run_id?: string; message?: string; error?: { message?: string } } | null;
}): BuildStartOutcome {
  if (res.status >= 200 && res.status < 300) return { phase: "started", runId: res.body?.run_id ?? null };
  if (res.status === 402) return { phase: "out_of_credits" };
  if (res.status === 409) return { phase: "expired" };
  if (res.status === 403) {
    return { phase: "failed", error: "Only the workspace owner or an admin can start this build." };
  }
  return {
    phase: "failed",
    error: res.body?.message ?? res.body?.error?.message ?? "Something went wrong starting the build.",
  };
}

const AGENT_NAMES: Record<string, string> = {
  operator: "Zavi",
  "chief-of-staff": "Chief of Staff",
  advisor: "Advisor",
  engineer: "Engineer",
  qa: "QA",
  pm: "Product Manager",
  cgo: "Chief Growth Officer",
  "growth-lead": "Head of Growth",
  "performance-marketer": "Ads Manager",
  "funnel-analysis": "Funnel Analyst",
  "seo-geo": "SEO & AI Search",
  "content-design": "Content Designer",
  "content-seo": "Content Designer",
  "support-lead": "Support Lead",
  "dispute-response": "Dispute Response",
  research: "Research",
  "browser-operator": "Browser Operator",
  fundraising: "Fundraising",
};

export function agentName(slug: string): string {
  return (
    AGENT_NAMES[slug] ??
    slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export type PausedStepStatus = "done" | "paused" | "pending";
export type PausedStep = { label: string; status: PausedStepStatus; creditsNeeded: number | null };
export type PausedModel = {
  agentName: string | null;
  pausedStep: number | null;
  totalSteps: number;
  steps: PausedStep[];
};

const STEP_STATUSES: readonly PausedStepStatus[] = ["done", "paused", "pending"];

export function parsePausedEnvelope(raw: unknown): PausedModel | null {
  if (!isObj(raw) || raw.envelope_kind !== "paused_out_of_credits") return null;
  const steps: PausedStep[] = Array.isArray(raw.steps)
    ? raw.steps
        .map((s): PausedStep | null => {
          if (!isObj(s) || !str(s.label)) return null;
          const status = STEP_STATUSES.includes(s.status as PausedStepStatus)
            ? (s.status as PausedStepStatus)
            : "pending";
          const creditsNeeded =
            typeof s.creditsNeeded === "number" && Number.isFinite(s.creditsNeeded)
              ? s.creditsNeeded
              : null;
          return { label: s.label as string, status, creditsNeeded };
        })
        .filter((s): s is PausedStep => s !== null)
    : [];
  if (steps.length === 0) return null;
  const total = raw.total_steps;
  const totalSteps =
    typeof total === "number" && Number.isFinite(total) && total > 0 ? Math.floor(total) : steps.length;
  const paused = raw.paused_step;
  const pausedStep =
    typeof paused === "number" && Number.isFinite(paused) && paused > 0
      ? Math.floor(paused)
      : steps.findIndex((s) => s.status === "paused") + 1 || null;
  return { agentName: str(raw.agent_name), pausedStep, totalSteps, steps };
}

export type VaultKey = {
  key: string;
  label: string;
  input: "text" | "email" | "password" | "url";
  required: boolean;
  placeholder?: string;
};

export type SetupModel = {
  rationale: string;
  keys: VaultKey[];
  missingRequiredConnectors: string[];
  missingOptionalConnectors: string[];
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

export function parseSetupEnvelope(raw: unknown): SetupModel | null {
  if (!isObj(raw) || raw.envelope_kind !== "setup_required") return null;
  const schema = isObj(raw.schema) ? raw.schema : {};
  const all: VaultKey[] = (Array.isArray(schema.vault_keys) ? schema.vault_keys : [])
    .filter((v): v is Obj => isObj(v) && !!str(v.key))
    .map((v) => ({
      key: v.key as string,
      label: str(v.label) ?? (v.key as string),
      input: (["text", "email", "password", "url"].includes(v.input as string)
        ? v.input
        : "text") as VaultKey["input"],
      required: v.required === true,
      placeholder: str(v.placeholder) ?? undefined,
    }));
  const seen = new Set<string>();
  const keys: VaultKey[] = [];
  for (const pass of [true, false]) {
    for (const v of all) {
      if (v.required === pass && !seen.has(v.key)) {
        keys.push(v);
        seen.add(v.key);
      }
    }
  }
  const missingRequiredConnectors = Array.isArray(raw.missing_required_connectors)
    ? strings(raw.missing_required_connectors)
    : strings(raw.missing_connectors);
  return {
    rationale: str(raw.rationale) ?? "",
    keys,
    missingRequiredConnectors,
    missingOptionalConnectors: strings(raw.missing_optional_connectors),
  };
}

export function setupCanSave(model: SetupModel, values: Record<string, string>): boolean {
  return model.keys.filter((k) => k.required).every((k) => (values[k.key] ?? "").trim().length > 0);
}

export function setupPayload(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const t = v.trim();
    if (t.length > 0) out[k] = t;
  }
  return out;
}

export type ClarifyOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  prefill?: boolean;
  provenance?: { source_id?: string; source_label?: string; excerpt?: string };
};

export type ClarifyQuestion = {
  id: string;
  text: string;
  header: string;
  why?: string;
  type: "single" | "multi" | "text";
  options: ClarifyOption[];
  allow_other: boolean;
  allow_skip?: boolean;
  required?: boolean;
  max_length?: number;
};

export type ClarifyModel = {
  request_id: string;
  intro?: string;
  submit_label?: string;
  questions: ClarifyQuestion[];
};

export type ClarifyAnswer = { optionIds: string[]; otherText: string; skipped: boolean };

export type StructuredAnswer = {
  question_id: string;
  option_ids?: string[];
  other_text?: string;
  skipped?: boolean;
};

export function parseClarifyEnvelope(raw: unknown): ClarifyModel | null {
  if (!isObj(raw) || raw.envelope_kind !== "clarifying_questions") return null;
  const requestId = str(raw.request_id);
  if (!requestId || !Array.isArray(raw.questions)) return null;
  const questions: ClarifyQuestion[] = raw.questions
    .filter((q): q is Obj => isObj(q) && !!str(q.id) && !!str(q.text))
    .map((q) => {
      const type = q.type === "multi" || q.type === "text" ? q.type : "single";
      return {
        id: q.id as string,
        text: q.text as string,
        header: str(q.header) ?? "Question",
        why: str(q.why) ?? undefined,
        type,
        options: (Array.isArray(q.options) ? q.options : [])
          .filter((o): o is Obj => isObj(o) && !!str(o.id) && !!str(o.label))
          .map((o) => ({
            id: o.id as string,
            label: o.label as string,
            description: str(o.description) ?? undefined,
            recommended: o.recommended === true,
            prefill: o.prefill === true,
            provenance: isObj(o.provenance)
              ? {
                  source_id: str(o.provenance.source_id) ?? undefined,
                  source_label: str(o.provenance.source_label) ?? undefined,
                  excerpt: str(o.provenance.excerpt) ?? undefined,
                }
              : undefined,
          })),
        allow_other: q.allow_other === true,
        allow_skip: q.allow_skip === true,
        required: q.required === true,
        max_length: typeof q.max_length === "number" ? q.max_length : undefined,
      };
    });
  if (questions.length === 0) return null;
  return {
    request_id: requestId,
    intro: str(raw.intro) ?? undefined,
    submit_label: str(raw.submit_label) ?? undefined,
    questions,
  };
}

export function emptyAnswer(): ClarifyAnswer {
  return { optionIds: [], otherText: "", skipped: false };
}

function prefillEligible(o: ClarifyOption): boolean {
  return o.prefill === true && !!o.provenance?.source_id;
}

export function seedAnswers(env: ClarifyModel): Record<string, ClarifyAnswer> {
  const out: Record<string, ClarifyAnswer> = {};
  for (const q of env.questions) {
    const a = emptyAnswer();
    if (q.type === "multi") a.optionIds = q.options.filter(prefillEligible).map((o) => o.id);
    else if (q.type === "single") {
      const first = q.options.find(prefillEligible);
      if (first) a.optionIds = [first.id];
    }
    out[q.id] = a;
  }
  return out;
}

export function toggleOption(q: ClarifyQuestion, a: ClarifyAnswer, optionId: string): ClarifyAnswer {
  const has = a.optionIds.includes(optionId);
  if (q.type === "single") return { ...a, optionIds: has ? [] : [optionId], skipped: false };
  return {
    ...a,
    optionIds: has ? a.optionIds.filter((x) => x !== optionId) : [...a.optionIds, optionId],
    skipped: false,
  };
}

export function isRequiredSatisfied(q: ClarifyQuestion, a: ClarifyAnswer): boolean {
  if (q.type === "text") return a.otherText.trim().length > 0;
  return a.optionIds.length > 0 || a.otherText.trim().length > 0;
}

export function missingRequired(
  env: ClarifyModel,
  answers: Record<string, ClarifyAnswer>,
): ClarifyQuestion[] {
  return env.questions.filter(
    (q) => q.required && !isRequiredSatisfied(q, answers[q.id] ?? emptyAnswer()),
  );
}

export function toStructuredAnswers(
  env: ClarifyModel,
  answers: Record<string, ClarifyAnswer>,
): StructuredAnswer[] {
  return env.questions.map((q) => {
    const a = answers[q.id] ?? emptyAnswer();
    const out: StructuredAnswer = { question_id: q.id };
    if (a.skipped) {
      out.skipped = true;
      return out;
    }
    if (a.optionIds.length > 0) out.option_ids = a.optionIds;
    if (a.otherText.trim().length > 0) out.other_text = a.otherText.trim();
    return out;
  });
}

export type EnvelopeOutline = { title: string; markdown: string };

function bulletFor(item: unknown): string | null {
  if (typeof item === "string" || typeof item === "number") return String(item);
  if (!isObj(item)) return null;
  const parts = Object.values(item)
    .filter((v): v is string | number => (typeof v === "string" && v.trim() !== "") || typeof v === "number")
    .slice(0, 3)
    .map(String);
  return parts.length ? parts.join(": ") : null;
}

const CONTENT_ARRAYS = ["items", "cards", "rows", "takeaways", "tiles", "bars"] as const;

function researchBlock(block: Obj): string[] {
  const out: string[] = [];
  if (block.type === "validation" || block.type === "source_list") return out;
  const heading = str(block.title) ?? str(block.heading);
  if (heading) out.push(`### ${heading}`);
  for (const [k, v] of Object.entries(block)) {
    if (k.endsWith("_md") && typeof v === "string" && v.trim()) out.push(v.trim());
  }
  for (const key of CONTENT_ARRAYS) {
    const v = block[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      const line = bulletFor(item);
      if (line) out.push(`- ${line}`);
    }
  }
  return out;
}

function researchOutline(env: Obj): EnvelopeOutline | null {
  if (env.kind === "clarification" && Array.isArray(env.questions)) {
    const qs = env.questions.filter(isObj);
    if (qs.length === 0) return null;
    const lines = qs.map((q, i) => `${i + 1}. **${String(q.question ?? "")}**${str(q.why) ? `\n${q.why}` : ""}`);
    return { title: "Questions to sharpen the research", markdown: lines.join("\n\n") };
  }
  if (env.kind !== "report") return null;
  const lines: string[] = [];
  if (str(env.subtitle)) lines.push(env.subtitle as string);
  for (const b of Array.isArray(env.blocks) ? env.blocks : []) {
    if (isObj(b)) lines.push(...researchBlock(b));
  }
  const sources = (Array.isArray(env.sources) ? env.sources : []).filter(isObj);
  if (sources.length > 0) {
    lines.push("### Sources");
    for (const s of sources) {
      const title = str(s.title) ?? str(s.url) ?? "Source";
      lines.push(str(s.url) ? `- [${title}](${s.url})` : `- ${title}`);
    }
  }
  return { title: str(env.title) ?? "Research report", markdown: lines.join("\n\n") };
}

function pmOutline(env: Obj): EnvelopeOutline | null {
  if (env.status === "actionable") {
    const backlog = (Array.isArray(env.backlog) ? env.backlog : []).filter(isObj);
    if (backlog.length === 0) return null;
    const lines: string[] = ["### RICE-ranked backlog"];
    backlog.forEach((item, i) => {
      const rice = typeof item.rice_score === "number" ? ` (RICE ${item.rice_score.toFixed(1)})` : "";
      const fix = str(item.proposed_fix) ? `: ${item.proposed_fix}` : "";
      lines.push(`- ${i + 1}. **${String(item.theme ?? "Item")}**${rice}${fix}`);
    });
    const dispatched = (Array.isArray(env.dispatched_actions) ? env.dispatched_actions : []).filter(isObj);
    if (dispatched.length > 0) {
      lines.push("### Dispatched to engineer");
      for (const d of dispatched) if (str(d.task_description)) lines.push(`- ${d.task_description}`);
    }
    const recommended = (
      Array.isArray(env.recommended_actions_not_dispatched) ? env.recommended_actions_not_dispatched : []
    ).filter(isObj);
    if (recommended.length > 0) {
      lines.push("### Recommended");
      for (const r of recommended) if (str(r.description)) lines.push(`- ${r.description}`);
    }
    return { title: "Backlog", markdown: lines.join("\n\n") };
  }
  if (env.status === "strategy_memo") {
    const strategy = isObj(env.strategy) ? env.strategy : {};
    const lines: string[] = [];
    if (str(strategy.premise_check)) lines.push("### Premise check", (strategy.premise_check as string).trim());
    const options = (Array.isArray(strategy.reframe_options) ? strategy.reframe_options : [])
      .filter(isObj)
      .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    if (options.length > 0) {
      lines.push("### Options");
      options.forEach((o, i) => {
        lines.push(`- ${i + 1}. **${String(o.title ?? "Option")}**${str(o.rationale) ? `: ${o.rationale}` : ""}`);
      });
    }
    const findings = (Array.isArray(strategy.research_findings) ? strategy.research_findings : []).filter(isObj);
    if (findings.length > 0) {
      lines.push("### Research findings");
      for (const f of findings) if (str(f.summary)) lines.push(`- ${f.summary}`);
    }
    if (lines.length === 0) return null;
    return { title: "Strategy options", markdown: lines.join("\n\n") };
  }
  return null;
}

export function envelopeOutline(slug: string, env: Obj | null): EnvelopeOutline | null {
  if (!env || env.envelope_kind === "setup_required" || env.envelope_kind === "clarifying_questions") {
    return null;
  }
  if (slug === "research") return researchOutline(env);
  if (slug === "pm") return pmOutline(env);
  return null;
}

export type DispatchProposal = { agent_slug: string; brief: string; why: string };

export function parseDispatchProposals(env: Obj | null): DispatchProposal[] {
  if (!env || !Array.isArray(env.dispatch_proposals)) return [];
  return env.dispatch_proposals
    .filter(
      (p): p is DispatchProposal =>
        isObj(p) &&
        typeof p.agent_slug === "string" &&
        typeof p.brief === "string" &&
        typeof p.why === "string",
    )
    .filter((p) => p.agent_slug !== "engineer");
}

export type CodeFile = { path: string; action: string; diff: string | null };

export type CodeChangeModel = {
  title: string;
  points: string[];
  risk: string | null;
  files: CodeFile[];
  lines: number;
};

function countDiffLines(diff: string): number {
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).length;
}

export function parseCodeChange(env: Obj | null): CodeChangeModel | null {
  if (!env || env.pending_pr_proposal !== true || !Array.isArray(env.files)) return null;
  const files: CodeFile[] = env.files
    .filter((f): f is Obj => isObj(f) && typeof f.path === "string" && f.path.length > 0)
    .map((f) => ({
      path: f.path as string,
      action: str(f.action) ?? "modify",
      diff: str(f.diff),
    }));
  if (files.length === 0) return null;
  const summary = str(env.customer_summary);
  const points = summary
    ? (summary.match(/[^.!?]+[.!?]*/g) ?? [])
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    title: str(env.title) ?? "Code change",
    points,
    risk: str(env.risk_class),
    files,
    lines: files.reduce((n, f) => n + (f.diff ? countDiffLines(f.diff) : 0), 0),
  };
}

export type HtmlPreviewModel = {
  title: string;
  summary: string;
  html: string | null;
  previewId: string | null;
};

export function parseHtmlPreview(env: Obj | null): HtmlPreviewModel | null {
  if (!env || env.kind !== "html_preview") return null;
  const html = typeof env.html === "string" ? env.html : null;
  const previewId =
    env.version === 2 && env.state === "html_preview_ready" && typeof env.preview_id === "string"
      ? env.preview_id
      : null;
  if (html === null && previewId === null) return null;
  return {
    title: str(env.title) ?? "Proposed design",
    summary: str(env.summary) ?? "",
    html,
    previewId,
  };
}

const PAGE_LINK_RE = /\/pages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function replyLinksAPage(text: string | null | undefined): boolean {
  return !!text && PAGE_LINK_RE.test(text);
}

const WARNING_PREFIXES = ["Not in this run's data:", "No pull in this run returned"];

export type SourcesFootnote = { summary: string; warning: string | null; detail: string };

export function sourcesFootnote(sources: string): SourcesFootnote {
  const [first, ...rest] = sources.split("\n");
  const summary = SOURCES_HEADERS.reduce((s, h) => s.replace(h, ""), first).trim();
  const warning = rest.find((l) => WARNING_PREFIXES.some((p) => l.startsWith(p))) ?? null;
  const detail = rest.filter((l) => l !== warning).join("\n").trim();
  return { summary, warning, detail };
}

export type ReplyCard =
  | { kind: "suggestions"; suggestions: string[] }
  | { kind: "buildConfirm"; confirm: BuildConfirm }
  | { kind: "schedule"; slug: string }
  | { kind: "connectorRequest"; request: ConnectorRequest }
  | { kind: "setup"; slug: string; model: SetupModel }
  | { kind: "htmlPreview"; model: HtmlPreviewModel }
  | { kind: "clarify"; slug: string; model: ClarifyModel }
  | { kind: "envelope"; outline: EnvelopeOutline }
  | { kind: "proposals"; proposals: DispatchProposal[] }
  | { kind: "sharedPages"; runId: string }
  | { kind: "liveApp"; runId: string }
  | { kind: "ruleSuggestion"; rule_id: string; text: string }
  | { kind: "codeChange"; model: CodeChangeModel; actionable: boolean }
  | { kind: "customAgent"; card: CustomAgentCardData; originRunId: string | null };

export type ReplyPlan = {
  body: string;
  sources: string | null;
  paused: PausedModel | null;
  cards: ReplyCard[];
  trailing: ReplyCard[];
};

type PlanInput = {
  body: string;
  agent_run_id: string | null;
  meta?: unknown;
};

export function planReplyCards(
  message: PlanInput,
  opts: { isLast: boolean; threadSlug: string },
): ReplyPlan {
  const meta = message.meta;
  const env = readEnvelope(meta);
  const split = splitSources(message.body ?? "");
  const plan: ReplyPlan = { body: split.body, sources: split.sources, paused: null, cards: [], trailing: [] };

  const paused = parsePausedEnvelope(env);
  if (paused) return { ...plan, paused };

  const slug = readFromAgentSlug(meta) ?? opts.threadSlug;

  const suggestions = readSuggestions(meta);
  if (opts.isLast && suggestions.length > 0) plan.cards.push({ kind: "suggestions", suggestions });

  const buildConfirm = isObj(meta) ? parseBuildConfirm(meta.build_confirm) : null;
  if (buildConfirm) plan.cards.push({ kind: "buildConfirm", confirm: buildConfirm });

  if (isObj(meta) && meta.standing_order === true) plan.cards.push({ kind: "schedule", slug });

  const connectorRequest = isObj(meta) ? parseConnectorRequest(meta.connector_request) : null;
  if (connectorRequest) plan.cards.push({ kind: "connectorRequest", request: connectorRequest });

  const setup = parseSetupEnvelope(env);
  if (setup) plan.cards.push({ kind: "setup", slug, model: setup });

  const htmlPreview = parseHtmlPreview(env);
  if (htmlPreview) plan.cards.push({ kind: "htmlPreview", model: htmlPreview });

  const clarify = parseClarifyEnvelope(env);
  if (clarify) plan.cards.push({ kind: "clarify", slug, model: clarify });

  const outline = envelopeOutline(slug, env);
  if (outline) plan.cards.push({ kind: "envelope", outline });

  const rs = isObj(meta) && isObj(meta.rule_suggestion) ? meta.rule_suggestion : null;
  if (rs && typeof rs.rule_id === "string" && rs.rule_id && typeof rs.text === "string" && rs.text) {
    plan.cards.push({ kind: "ruleSuggestion", rule_id: rs.rule_id, text: rs.text });
  }

  const customAgent = isObj(meta) ? parseCustomAgentCard(meta.custom_agent_draft) : null;
  if (customAgent) plan.cards.push({ kind: "customAgent", card: customAgent, originRunId: message.agent_run_id });

  const proposals = parseDispatchProposals(env);
  if (proposals.length > 0) plan.cards.push({ kind: "proposals", proposals });

  const codeChange = parseCodeChange(env);
  if (codeChange) plan.cards.push({ kind: "codeChange", model: codeChange, actionable: opts.isLast });

  if (message.agent_run_id && replyLinksAPage(message.body)) {
    plan.trailing.push({ kind: "sharedPages", runId: message.agent_run_id });
  }
  if (opts.isLast && message.agent_run_id) {
    plan.trailing.push({ kind: "liveApp", runId: message.agent_run_id });
  }
  return plan;
}
