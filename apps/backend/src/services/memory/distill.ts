
import {
  hasUnverifiedAbsenceRisk,
  assertsNegativeExistence,
} from "@/services/agents/unverified-absence-verifier";
import { sanitizeDurableClaims } from "./absence-sanitizer";
import { DEFAULT_MODEL } from "@/services/anthropic";
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER } from "@/services/llm/models";
import { writeNote, deleteNote, persistTypedGraph, type WriteNoteInput } from ".";
import type { ToolCallTrace } from "@/services/tools/types";
import { extractEntitiesAndRelations } from "./extract";
import { isLlmEntityExtractEnabledForTenant } from "./llm-entity-extract-flag";
import {
  finalTrustTier,
  parseGateFields,
  renderProposalsBlock,
  renderSavedMemoryBlock,
  resolveGateDecision,
  writeGateRules,
  type ExistingFact,
  type GateFields,
} from "./write-gate";
import {
  defaultWriteGateDeps,
  MAX_PROPOSALS_PER_RUN,
  PROPOSAL_PROMPT_BODY_CHARS,
  type MemoryProposal,
  type WriteGateDeps,
  type WriteLogEntry,
} from "./write-path";
import { logReview } from "@/services/logging/log-review";
import { logEvent } from "@/services/logging/logEvent";

export type DistillArtifact = {
  note_type:
    | "operator_preference"
    | "agent_feedback"
    | "tenant_project"
    | "tenant_reference"
    | "agent_procedural";
  title: string;
  body_markdown: string;
  tags: string[];
  rationale: string;
  gate?: GateFields;
  user_quote?: string;
  proposal_ref?: string;
};

export type DistillSource =
  | "auto_distill_chat"
  | "auto_distill_agent_run"
  | "auto_distill_slack";

export type RunDistillInput = {
  tenant_id: string;
  source: DistillSource;
  source_ref: string;
  systemPrompt: string;
  userPrompt: string;
  baseTags: string[];
  budgetTokens?: number;
  model?: string;
  thread_id?: string | null;
  toolCalls?: ToolCallTrace[];
  agent_slug?: string | null;
  operator_message?: string | null;
  connector_object_keys?: string[] | null;
  dropUnverifiedAbsenceFacts?: boolean;
  readBudgetRefused?: boolean;
  liveConnectors?: readonly string[];
  gate?: {
    ceiling: number;
    queryText: string;
    run_id?: string | null;
    thread_message_id?: string | null;
    deps?: Partial<WriteGateDeps>;
  };
  proposals?: {
    agent_slug: string | null;
    items: MemoryProposal[];
  };
};

export type RunDistillResult = {
  written: number;
  skipped: number;
  failed: number;
  tokens: { input: number; output: number };
};

const DEFAULT_BUDGET_TOKENS = 1500;
const BUDGET_TOKENS_PER_PROPOSAL = 1500;
const MAX_BUDGET_TOKENS = 12000;

export function distillBudgetTokens(
  base: number,
  proposals: ReadonlyArray<Pick<MemoryProposal, "body">>,
): number {
  const extra = proposals.reduce(
    (sum, p) =>
      sum +
      Math.max(BUDGET_TOKENS_PER_PROPOSAL, Math.ceil(Math.min(p.body.length, PROPOSAL_PROMPT_BODY_CHARS) / 2)),
    0,
  );
  return Math.min(MAX_BUDGET_TOKENS, base + extra);
}
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 8000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 40;

const VALID_NOTE_TYPES: ReadonlySet<DistillArtifact["note_type"]> = new Set([
  "operator_preference",
  "agent_feedback",
  "tenant_project",
  "tenant_reference",
  "agent_procedural",
]);

function isArtifact(x: unknown): x is DistillArtifact {
  if (!x || typeof x !== "object") return false;
  const a = x as Partial<DistillArtifact>;
  return (
    typeof a.note_type === "string" &&
    VALID_NOTE_TYPES.has(a.note_type as DistillArtifact["note_type"]) &&
    typeof a.title === "string" &&
    a.title.length > 0 &&
    typeof a.body_markdown === "string" &&
    a.body_markdown.length > 0
  );
}

const ABSENCE_VERB_RE =
  /\b(?:block(?:ed|s)?|missing|does ?n['o]?t exist|not implemented|unimplemented|unavailable|could ?n['o]?t (?:locate|find|implement|ship|add)|still missing|pending|held by|not (?:yet )?(?:live|merged|available|implemented|reachable)|cannot be (?:implemented|shipped|added)|attempted but|never (?:merged|shipped|implemented))\b/i;
const CAP_NOUN_RE = /\b(?:endpoint|route|api|backend|capability|handler|controller)\b/i;

export function assertsBlockedCapability(a: DistillArtifact): boolean {
  if (a.note_type !== "tenant_reference" && a.note_type !== "tenant_project") return false;
  const text = `${a.title}\n${a.body_markdown}`;
  return ABSENCE_VERB_RE.test(text) && CAP_NOUN_RE.test(text);
}

const SHIP_CLAIM_RE =
  /\b(?:(?:just |recently )?(?:shipped|launched|rolled out)|went live|is live|are live|now (?:live|available|supports?)|can now|in production|feature is (?:shipped|done|complete))\b/i;

const ATTRIBUTED_RE =
  /\b(?:reported|stated|said|according to|per the operator|operator-reported|unverified)\b/i;

export const SHIP_CLAIM_ATTRIBUTION =
  "> Reported, not verified against the codebase. Treat the ship status below " +
  "as a claim rather than a confirmed fact, and check the live code before " +
  "telling anyone this is available.";

export const UNVERIFIED_SHIP_CLAIM_TAG = "unverified_ship_claim";

const SHIP_NEGATION_RE =
  /\b(?:not|never|isn't|aren't|wasn't|weren't|won't|hasn't|haven't|has not|have not|had not|no longer|not yet|yet to be|still|without)\b[^.!?]{0,24}$/i;
const SHIP_NEGATION_LOOKBACK = 40;

function hasAffirmativeShipClaim(text: string): boolean {
  const g = new RegExp(SHIP_CLAIM_RE.source, "gi");
  for (const m of text.matchAll(g)) {
    const i = m.index ?? 0;
    const window = text.slice(Math.max(0, i - SHIP_NEGATION_LOOKBACK), i);
    if (!SHIP_NEGATION_RE.test(window)) return true;
  }
  return false;
}

export function assertsUnverifiedShipClaim(a: DistillArtifact): boolean {
  if (a.note_type !== "tenant_reference" && a.note_type !== "tenant_project") return false;
  const text = `${a.title}\n${a.body_markdown}`;
  if (!hasAffirmativeShipClaim(text)) return false;
  return !ATTRIBUTED_RE.test(text);
}

export function attributeShipClaim(a: DistillArtifact): DistillArtifact {
  if (!assertsUnverifiedShipClaim(a)) return a;
  return {
    ...a,
    body_markdown: `${SHIP_CLAIM_ATTRIBUTION}\n\n${a.body_markdown}`,
    tags: [...(a.tags ?? []), UNVERIFIED_SHIP_CLAIM_TAG],
  };
}

export function assertsNegativeExistenceArtifact(a: DistillArtifact): boolean {
  if (a.note_type !== "tenant_reference" && a.note_type !== "tenant_project") return false;
  return assertsNegativeExistence(`${a.title}\n${a.body_markdown}`).length > 0;
}

function ensureShipClaimTag(tags: string[], a: DistillArtifact): string[] {
  const bannered = a.body_markdown.startsWith(SHIP_CLAIM_ATTRIBUTION);
  if (!bannered || tags.includes(UNVERIFIED_SHIP_CLAIM_TAG)) return tags;
  if (tags.length < MAX_TAGS) return [...tags, UNVERIFIED_SHIP_CLAIM_TAG];
  return [...tags.slice(0, MAX_TAGS - 1), UNVERIFIED_SHIP_CLAIM_TAG];
}

function withProposal(x: unknown, proposalsByRef: ReadonlyMap<string, MemoryProposal>): unknown {
  if (!x || typeof x !== "object") return x;
  const a = { ...(x as Record<string, unknown>) };
  const ref = typeof a.proposal_ref === "string" ? a.proposal_ref.trim() : "";
  const p = ref ? proposalsByRef.get(ref) : undefined;
  if (!p) {
    delete a.proposal_ref;
    return a;
  }
  a.proposal_ref = ref;
  const modelTags = Array.isArray(a.tags) ? a.tags : [];
  a.tags = [...p.tags, ...modelTags.filter((t) => !p.tags.includes(t as string))];
  if (typeof a.title !== "string" || a.title.length === 0) a.title = p.title || p.body.slice(0, 80);
  if (typeof a.body_markdown !== "string" || a.body_markdown.length === 0) a.body_markdown = p.body;
  if (typeof a.note_type !== "string" || !VALID_NOTE_TYPES.has(a.note_type as DistillArtifact["note_type"])) {
    a.note_type = "tenant_reference";
  }
  return a;
}

const GATE_ACTION_SET: ReadonlySet<string> = new Set(["add", "duplicate", "update", "reject"]);

function hasProposalRef(x: unknown): boolean {
  return !!x && typeof x === "object" && typeof (x as { proposal_ref?: unknown }).proposal_ref === "string";
}

const MIN_USER_QUOTE_CHARS = 10;

function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function operatorSentencesFor(quote: string, operatorMessage: string): string | null {
  const segments = operatorMessage
    .split(/(?<=[.!?])\s+|\n+/)
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined = segments.join(" ").toLowerCase();
  const q = normalizeForQuote(quote);
  const idx = joined.indexOf(q);
  if (idx < 0 || !q) return null;
  const end = idx + q.length;
  const kept: string[] = [];
  let offset = 0;
  for (const seg of segments) {
    const segEnd = offset + seg.length;
    if (segEnd > idx && offset < end) kept.push(seg);
    offset = segEnd + 1;
  }
  return kept.join(" ") || null;
}

export function isOperatorQuote(quote: unknown, operatorMessage: string | null | undefined): boolean {
  if (typeof quote !== "string" || !operatorMessage) return false;
  const q = normalizeForQuote(quote);
  if (q.length < MIN_USER_QUOTE_CHARS) return false;
  return normalizeForQuote(operatorMessage).includes(q);
}

function sanitizeTags(input: unknown, baseTags: string[]): string[] {
  const tags: string[] = [...baseTags];
  if (Array.isArray(input)) {
    for (const t of input) {
      if (typeof t !== "string") continue;
      const clean = t.trim().slice(0, MAX_TAG_CHARS);
      if (clean.length > 0) tags.push(clean);
      if (tags.length >= MAX_TAGS) break;
    }
  }
  return tags.slice(0, MAX_TAGS);
}

function parseArtifacts(
  raw: string,
  proposalsByRef: ReadonlyMap<string, MemoryProposal> = new Map(),
): { artifacts: DistillArtifact[]; unparseable: boolean } {
  if (!raw || !raw.trim()) return { artifacts: [], unparseable: false };
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { artifacts?: unknown[] };
    if (!parsed || !Array.isArray(parsed.artifacts)) return { artifacts: [], unparseable: true };
    const artifacts = parsed.artifacts
      .filter((x) => !hasProposalRef(x) || GATE_ACTION_SET.has((x as { action?: unknown }).action as string))
      .map((x) => withProposal(x, proposalsByRef))
      .filter(isArtifact)
      .map((a) => ({
        ...a,
        user_quote: typeof a.user_quote === "string" ? a.user_quote.slice(0, 1000) : undefined,
        gate: parseGateFields(
          a as unknown as Record<string, unknown>,
          `${a.title}\n${a.body_markdown}`,
        ),
      }));
    return { artifacts, unparseable: false };
  } catch {
    return { artifacts: [], unparseable: true };
  }
}

export async function runDistill(input: RunDistillInput): Promise<RunDistillResult> {
  const proposals = input.gate ? (input.proposals?.items ?? []).slice(0, MAX_PROPOSALS_PER_RUN) : [];
  const proposalsByRef = new Map(proposals.map((p, i) => [`P${i + 1}`, p]));
  const budget = distillBudgetTokens(input.budgetTokens ?? DEFAULT_BUDGET_TOKENS, proposals);
  const model = input.model ?? DEFAULT_MODEL;
  const gateDeps: WriteGateDeps = { ...defaultWriteGateDeps, ...(input.gate?.deps ?? {}) };

  let existing: ExistingFact[] = [];
  if (input.gate) {
    try {
      existing = await gateDeps.loadExistingFacts(input.tenant_id, {
        queryText:
          proposals.length > 0
            ? `${input.gate.queryText.slice(0, 2000)}\n\n${proposals
                .map((p) => `${p.title}\n${p.body}`)
                .join("\n")}`.slice(0, 4000)
            : input.gate.queryText,
        run_id: input.gate.run_id ?? null,
      });
    } catch (e) {
      console.warn(`[distill] saved-memory lookup failed for ${input.source_ref}: ${(e as Error).message}`);
    }
  }
  const proposalsBlock = renderProposalsBlock(
    [...proposalsByRef.entries()].map(([ref, p]) => ({
      ref,
      title: p.title,
      body: p.body.slice(0, PROPOSAL_PROMPT_BODY_CHARS),
    })),
  );
  const userPrompt = input.gate
    ? [input.userPrompt, proposalsBlock, renderSavedMemoryBlock(existing)].filter(Boolean).join("\n\n")
    : input.userPrompt;

  const resp = await callModel({
    provider: DEFAULT_PROVIDER,
    model,
    max_tokens: budget,
    system: input.systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tags: {
      tenantId: input.tenant_id,
      agentSlug: input.source,
      runId: input.source_ref,
    },
  });

  const { artifacts: parsed, unparseable } = parseArtifacts(resp.text, proposalsByRef);
  const decidedRefs = new Set(parsed.map((a) => a.proposal_ref).filter((r): r is string => !!r));
  const proposalsUnjudged = decidedRefs.size < proposals.length;
  if (unparseable && proposals.length > 0) {
    void logEvent({
      level: "warn",
      source: "memory.distill",
      code: "memory_write.distill_unparseable",
      tenant_id: input.tenant_id,
      run_id: input.gate?.run_id ?? input.source_ref,
      meta: { count: proposals.length, output_tokens: resp.usage.output_tokens, cap: budget },
    }).catch(() => {});
  }

  const readBudgetRefused =
    input.readBudgetRefused ?? hasUnverifiedAbsenceRisk(input.toolCalls ?? []);
  const droppedProposalLogs: Array<Omit<WriteLogEntry, "source" | "action">> = [];
  let claimsRedacted = 0;
  let sentencesExcised = 0;
  let shipClaimsAttributed = 0;
  const artifacts: DistillArtifact[] = [];
  for (const a of parsed) {
    const s = sanitizeDurableClaims({
      title: a.title,
      body: a.body_markdown,
      note_type: a.note_type,
      liveConnectors: input.liveConnectors,
      readBudgetRefused,
      dropBlockedCapability: input.dropUnverifiedAbsenceFacts === true,
    });
    if (s.dropped) {
      console.warn(
        `[distill] dropped artifact for ${input.source}/${input.source_ref}: ${s.dropReason}`,
      );
      if (a.proposal_ref) {
        droppedProposalLogs.push({
          candidate_title: a.title,
          candidate_body: a.body_markdown,
          candidate_note_type: a.note_type,
          reason: `sanitizer:${s.dropReason ?? "dropped"}`,
        });
      }
      continue;
    }
    claimsRedacted += s.withheldConnectors.length;
    sentencesExcised += s.sentencesRemoved;
    const cleaned: DistillArtifact = { ...a, title: s.title, body_markdown: s.body };
    const attributed = attributeShipClaim(cleaned);
    if (attributed !== cleaned) shipClaimsAttributed += 1;
    artifacts.push(attributed);
  }
  if (claimsRedacted > 0 || sentencesExcised > 0) {
    console.warn(
      `[distill] excised ${claimsRedacted} disproven connector claim(s) + ${sentencesExcised} absence sentence(s) for ${input.source}/${input.source_ref}`,
    );
  }
  if (shipClaimsAttributed > 0) {
    console.warn(
      `[distill] attributed ${shipClaimsAttributed} unverified ship claim(s) for ${input.source}/${input.source_ref}`,
    );
  }

  let written = 0;
  let failed = 0;
  let skipped = parsed.length - artifacts.length;
  const existingByRef = new Map(existing.map((e) => [e.ref, e]));
  const logEntries: WriteLogEntry[] = [];
  const decisionCounts: Record<string, number> = {};
  const logBase = {
    source: input.source,
    run_id: input.gate?.run_id ?? null,
    thread_id: input.thread_id ?? null,
    thread_message_id: input.gate?.thread_message_id ?? null,
  };
  for (const d of droppedProposalLogs) logEntries.push({ ...logBase, action: "rejected", ...d });

  const llmEntityExtractOwnedByWriteNote = await isLlmEntityExtractEnabledForTenant(
    input.tenant_id,
  );

  for (const a of artifacts) {
    if (a.note_type === "operator_preference" || a.note_type === "agent_procedural") {
      skipped += 1;
      if (input.gate) {
        logEntries.push({
          ...logBase,
          action: "rejected",
          candidate_title: a.title,
          candidate_body: a.body_markdown,
          candidate_note_type: a.note_type,
          reason: "standing_instruction_is_a_rule",
        });
      }
      continue;
    }
    let decision: ReturnType<typeof resolveGateDecision> | null = null;
    let gateTier: number | undefined;
    if (input.gate && a.gate) {
      gateTier = finalTrustTier(input.gate.ceiling, a.gate.source_class);
      decision = resolveGateDecision(
        { ...a.gate, title: a.title, body: a.body_markdown },
        existingByRef,
        gateTier,
      );
      decisionCounts[decision.kind] = (decisionCounts[decision.kind] ?? 0) + 1;
      if (decision.kind === "reject" || decision.kind === "duplicate") {
        skipped += 1;
        logEntries.push({
          ...logBase,
          action: decision.kind === "duplicate" ? "duplicate" : decision.junk ? "junk" : "rejected",
          matched_note_id: decision.kind === "duplicate" ? decision.matched.note_id : null,
          candidate_title: a.title,
          candidate_body: a.body_markdown,
          candidate_note_type: a.note_type,
          reason: decision.reason,
        });
        continue;
      }
    }
    const noteInput: WriteNoteInput = {
      title: a.title.slice(0, MAX_TITLE_CHARS),
      body_markdown: a.body_markdown.slice(0, MAX_BODY_CHARS),
      source: input.source,
      source_ref: input.source_ref,
      tags: ensureShipClaimTag(sanitizeTags(a.tags, input.baseTags), a),
      note_type: a.note_type,
      thread_id:
        input.thread_id ??
        (a.proposal_ref ? proposalsByRef.get(a.proposal_ref)?.thread_id ?? null : null),
      connector_object_keys: input.connector_object_keys ?? null,
      toolCalls: input.toolCalls,
      ...(decision && a.gate
        ? {
            subject: a.gate.subject,
            attribute: a.gate.attribute,
            value_kind: a.gate.value_kind,
            source_class: a.gate.source_class,
            trust_tier: gateTier,
          }
        : {}),
    };
    try {
      const { note_id, created } = await writeNote(input.tenant_id, noteInput);
      written += 1;
      if (a.proposal_ref && created === true && input.gate?.run_id && input.proposals?.agent_slug) {
        const stamp =
          gateDeps.stampCustomAgentProvenance ??
          (await import("@/services/tools/memory/write")).stampCustomAgentProvenance;
        await stamp(input.tenant_id, input.gate.run_id, input.proposals.agent_slug, note_id);
      }
      if (decision) {
        let action: WriteLogEntry["action"] = "added";
        let matched: string | null = null;
        let reason: string | null = null;
        if (decision.kind === "update") {
          matched = decision.target.note_id;
          if (note_id === decision.target.note_id) {
            action = "duplicate";
            reason = "content_hash_merge";
          } else if (await gateDeps.supersedeForUpdate(input.tenant_id, note_id, decision.target.note_id)) {
            action = "updated";
          } else {
            reason = "update_supersede_failed";
          }
        } else if (decision.kind === "conflict") {
          matched = decision.target.note_id;
          if (note_id !== decision.target.note_id) {
            action = "conflict";
            reason = decision.reason;
            try {
              await gateDeps.openConflictPair(input.tenant_id, {
                existing_note_id: decision.target.note_id,
                new_note_id: note_id,
                subject: a.gate?.subject ?? null,
                attribute: a.gate?.attribute ?? null,
                reason: decision.reason,
                run_id: input.gate?.run_id ?? null,
              });
            } catch (e) {
              written -= 1;
              if (created) {
                await deleteNote(input.tenant_id, note_id, null, "conflict pair could not be opened").catch(() => {});
              }
              throw e;
            }
          } else {
            action = "duplicate";
            reason = "content_hash_merge";
          }
        } else if (decision.kind === "add") {
          reason = decision.reason;
        }
        logEntries.push({
          ...logBase,
          action,
          note_id,
          matched_note_id: matched,
          candidate_title: a.title,
          candidate_body: a.body_markdown,
          candidate_note_type: a.note_type,
          reason,
        });
      }

      if (!llmEntityExtractOwnedByWriteNote) {
        try {
          const graph = await extractEntitiesAndRelations(
            `${noteInput.title}\n\n${noteInput.body_markdown}`,
            input.tenant_id,
          );
          if (graph.entities.length > 0 || graph.relations.length > 0) {
            await persistTypedGraph(input.tenant_id, note_id, graph);
          }
        } catch (e) {
          console.warn(
            `[distill] typed-graph extraction failed for ${input.source}/${input.source_ref} note ${note_id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      skipped += 1;
      failed += 1;
      console.warn(
        `[distill] writeNote failed for ${input.source}/${input.source_ref}: ${(e as Error).message}`,
      );
    }
  }

  if (input.gate) {
    await gateDeps.recordWrites(input.tenant_id, logEntries);
    if (failed === 0 && decidedRefs.size > 0) {
      const ids = [...decidedRefs].map((r) => proposalsByRef.get(r)!.id);
      await gateDeps.markProposalsDecided(input.tenant_id, ids);
    }
    try {
      logReview({
        feature: "memory_write",
        event: "distill",
        outcome: failed > 0 || proposalsUnjudged ? "failed" : "ok",
        run_id: input.gate.run_id ?? input.source_ref,
        tenant_id: input.tenant_id,
        meta: {
          shown: existing.length,
          proposed: parsed.length,
          proposals: proposals.length,
          proposals_decided: decidedRefs.size,
          added: decisionCounts.add ?? 0,
          duplicate: decisionCounts.duplicate ?? 0,
          updated: decisionCounts.update ?? 0,
          conflict: decisionCounts.conflict ?? 0,
          rejected: decisionCounts.reject ?? 0,
          failed,
        },
      });
    } catch {
    }
  }

  return {
    written,
    failed,
    skipped,
    tokens: {
      input: resp.usage.input_tokens,
      output: resp.usage.output_tokens,
    },
  };
}

export const CHAT_DISTILL_SYSTEM_PROMPT = `You are the Praxis chat distiller. You read a single chat turn between an operator and one of their agents and decide what (if anything) is durable knowledge worth saving in the company brain.

Classify each durable fact into ONE of:
- agent_feedback: the operator critiqued ONE reply of the agent
  ("That reply is too cold", "Too many bullet points in that answer", "Use the customer's first name next time")
- tenant_project: an ongoing initiative, milestone, or in-progress workstream
  ("Launching India market in June", "Currently negotiating Stripe Connect terms with Visa")
- tenant_reference: a stable fact about the business, customers, vendors, or product
  ("Our average customer orders 3.2 times a year", "Vendor: SendGrid, contact ops@example.com", "Primary geo: California Bay Area")

STANDING INSTRUCTIONS ARE NOT SAVED HERE. A lasting rule about how the team should behave ("from now on…", "always…", "never…", "stop doing…") is offered to the operator as a rule they can save; it is not memory. Emit nothing for it.

FACTUAL CORRECTIONS ARE THE HIGHEST-VALUE ARTIFACT — never drop one.
When the operator CORRECTS a factual error the agent made ("that's wrong", "we already launched that", "no, it's X not Y", "that's not how it works"), save the CORRECTED FACT as a \`tenant_reference\`. This is the one case where you should lean toward writing rather than skipping.

Save the FACT, in the operator's terms — NOT the agent's reaction to being corrected.
- RIGHT: {"note_type":"tenant_reference","title":"Team plan launched before July 2026","body_markdown":"The Team plan is an established, already-launched product — not a new launch. Do not describe it as 'live' or 'new' in customer copy; the newsworthy thing is whatever feature is actually shipping."}
- WRONG: {"title":"Agent acknowledged the correction","body_markdown":"The agent said 'Good catch' and revised the email."} — that is an episode, not a fact. It teaches a future agent NOTHING. If your artifact would only make sense to someone who read this conversation, it is the wrong artifact.

State the corrected fact so it answers the question the agent got wrong, standing alone, months later, to an agent that never saw this thread.

CAUTION — do not over-read the correction. Save ONLY what the operator actually asserted. If he says "lots of people don't know about the launch", that is a claim about AWARENESS, not about launch state — it does not mean the product is unlaunched. When the operator's wording is ambiguous about the underlying fact, write nothing rather than guess: a confidently wrong fact in the brain is worse than no fact.

NEVER record a SHIP STATUS as an objective fact. When the operator says a feature shipped / is live / launched — especially as an aside inside a request for something else ("we just shipped X, please draft test cases") — the ship status is an UNEXAMINED PREMISE, not a verified fact. Write it ATTRIBUTED and time-bound ("The operator reported that X shipped"), never bare ("X is shipped", "Guests can now do X"). An unattributed ship claim reads as verified ground truth months later, and an agent will repeat it to a customer as fact. This is the 2026-06-05 split-payment incident: "we just shipped split payment, draft test cases" became the note "Feature is shipped and ready for QA test case validation", and two months later an agent told a customer in Slack that split payment was live. It never existed.

NEVER treat an artifact the AGENT produced as evidence that work was done. Test cases the agent drafted are not QA coverage that ran. A plan the agent wrote is not a shipped feature. A PR description is not a merge. Record what happened, not what was described.

DEFAULT TO ZERO ARTIFACTS. False positives are expensive — they pollute future agent context and the operator has to clean them up. If the turn is small talk or the agent executing a one-off task with no durable signal, output {"artifacts":[]}.

${writeGateRules({ agentProcedural: false })}`;

export const AGENT_RUN_DISTILL_SYSTEM_PROMPT = `You are the Praxis agent-run distiller. You read the output of a Praxis agent that just completed a scheduled or manually-triggered run (not a chat turn) and decide whether the run produced any durable knowledge about how this operator's business actually works.

Classify each durable observation into ONE of:
- tenant_reference: stable facts the agent learned about the business, customers, vendors, or systems
- tenant_project: ongoing initiatives or in-progress work the agent identified
- agent_feedback: things the agent itself noticed it should do differently next time (e.g. "I tried X and it failed, future runs should try Y first")

Never write a rule about how the operator wants things done: only the operator's own words, saved by them on the Rules page, can set one.

NEVER record a SHIP STATUS as an objective fact. If the run (or the operator, or a Slack message the run read) says a feature shipped / is live / launched, write it ATTRIBUTED ("The operator reported that X shipped"), never bare ("X is shipped"). An unattributed ship claim reads as verified ground truth months later and an agent will repeat it to a customer as fact. Test cases or plans the agent itself drafted are NEVER evidence that the work shipped or that QA ran.

NEVER record an UNVERIFIED ABSENCE as a fact. If the run got stuck, refused, or concluded that a code capability is MISSING / BLOCKED / NOT-IMPLEMENTED / PENDING (e.g. "the backend endpoint doesn't exist", "the API route is missing", "blocked on the X contract"), do NOT emit it as tenant_reference or tenant_project — a stuck run's guess about what the code lacks is not a stable business fact, and storing it poisons every future run. At most emit it as agent_feedback phrased as the agent's OWN next-time learning ("I concluded endpoint X was missing and stalled; future runs should grep/read the live code to confirm before concluding absence"). Never assert the absence itself as true.

DEFAULT TO ZERO ARTIFACTS. Most agent runs produce no durable signal — they execute a known task and report status. The brain only wants signal that changes how future runs should behave.

${writeGateRules({ agentProcedural: false })}`;
