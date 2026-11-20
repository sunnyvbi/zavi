
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_VARIANT,
  VariantConfigSchema,
  type ResolvedVariant,
} from "../engine/variant-config";
import { LAB_ALWAYS_DENY, LAB_ALWAYS_DENY_FULL, LAB_DENY_CODE, labBareToolName } from "./lab-gate";
import { labChannelCards, type LabCardOutcome, type LabCards } from "./lab-cards";
export { checkLabCardStore, setLabCardStoreStatus } from "./lab-cards";
import { effectOf } from "@/services/mcp/tool-effects";
import { fromAnthropicName } from "@/services/mcp/types";
import { withLabDbWriteLog } from "./lab-db-guard";
import { loadChannelRecipe, type ChannelRecipe } from "@/services/channels/recipe";
import { newLabReadCache, withLabReadCache } from "./lab-read-cache";
import { DEFAULT_AGENTS_ROOT, loadFileVariants, type FileVariant } from "./file-variants";
import { existsSync } from "node:fs";
import path from "node:path";

import { releaseRunFigures } from "@/services/agents/engine/figure-ledger";
import type { AgentContext, AgentTrigger, DispatcherResult } from "../types";
import type { ClaimedAgentRun } from "../runner";

const CHAT_REPLAY_HISTORY = 10;

async function chatReplayText(sb: SupabaseClient, tenantId: string, messageId: string): Promise<string> {
  const msg = await sb
    .from("agent_thread_messages")
    .select("body, thread_id, created_at, attachments")
    .eq("tenant_id", tenantId)
    .eq("id", messageId)
    .limit(1);
  if (msg.error) throw new Error(`chat message read failed: ${msg.error.message}`);
  const row = ((msg.data ?? []) as Array<{ body?: unknown; thread_id?: unknown; created_at?: unknown; attachments?: unknown }>)[0];
  if (!row || typeof row.body !== "string" || !row.body) return "";
  if (Array.isArray(row.attachments) && row.attachments.length > 0) {
    throw new LabInputError("that chat message had attachments, which a replay cannot carry yet");
  }
  if (typeof row.thread_id !== "string" || typeof row.created_at !== "string") return row.body;
  const prior = await sb
    .from("agent_thread_messages")
    .select("sender_role, body, created_at, attachments")
    .eq("tenant_id", tenantId)
    .eq("thread_id", row.thread_id)
    .is("meta->>superseded_by", null)
    .lt("created_at", row.created_at)
    .order("created_at", { ascending: false })
    .limit(CHAT_REPLAY_HISTORY);
  if (prior.error) throw new Error(`chat history read failed: ${prior.error.message}`);
  const priorRows = (prior.data ?? []) as Array<{ sender_role?: unknown; body?: unknown; attachments?: unknown }>;
  if (priorRows.some((t) => Array.isArray(t.attachments) && t.attachments.length > 0)) {
    throw new LabInputError("an earlier message in that chat had attachments, which a replay cannot carry yet");
  }
  const turns = priorRows
    .filter((t) => (t.sender_role === "user" || t.sender_role === "assistant") && typeof t.body === "string" && t.body)
    .reverse()
    .map((t) => `${t.sender_role === "user" ? "Founder" : "You"}: ${t.body as string}`);
  if (turns.length === 0) return row.body;
  return `Earlier in this conversation:\n${turns.join("\n\n")}\n\nThe founder now says:\n${row.body}`;
}

function defaultLoadRecipe(channelSlug: string, variantFile?: string): Pick<ChannelRecipe, "body" | "meta"> {
  return loadChannelRecipe(channelSlug, variantFile);
}

function defaultPromptFileExists(agentSlug: string, agentFile: string): boolean {
  return existsSync(path.join(DEFAULT_AGENTS_ROOT, agentSlug, `agent.${agentFile}.md`));
}

export const MAX_LAB_VARIANTS = 6;
export const LAB_VARIANT_TIMEOUT_MS = 8 * 60_000;
export const LAB_CHANNEL_TIMEOUT_MS = 25 * 60_000;
export const DEFAULT_SLUG = "default";

const LAB_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_LAB_IMAGES = 5;

export type LabImage = { mime: string; base64: string };

export type LabInput =
  | { kind: "operator_text"; text: string; images?: LabImage[] }
  | { kind: "past_run"; runId: string }
  | { kind: "cgo_latest" }
  | { kind: "cgo_reply"; text: string }
  | { kind: "cgo_fresh" }
  | { kind: "channel_fresh" };

export type LabToolCall = {
  name: string;
  status: "ok" | "blocked" | "error" | "simulated";
  input_preview: string;
  output_preview: string;
  is_error: boolean;
  ms: number;
  code?: string;
};

export const LAB_BLOCKED_INPUT_CHARS = 2000;

export type LabVariantResult = {
  slug: string;
  label: string;
  source?: "default" | "prod" | "local";
  ok: boolean;
  error?: string;
  output_text?: string;
  tool_calls?: LabToolCall[];
  blocked?: string[];
  tokens?: { input: number; output: number; cache_read?: number; cache_write?: number };
  cost_usd?: number | null;
  ms: number;
  moves?: unknown;
  would_file?: unknown;
  moves_error?: string;
  moves_refused?: string[];
  prompt_snapshot?: string;
  resolved_slug?: string | null;
  ran_as_default?: boolean;
  blocked_db_writes?: string[];
  parse_ok?: boolean;
  parse_error?: string;
  cards?: LabCards;
  no_cards_reason?: string;
  proposals?: Array<{ tool: string; input: string }>;
  simulated?: string[];
  model?: string;
  effort?: string;
  stop_reason?: string;
  side_effect?: { kind: string; reason?: string };
  visible_text?: string;
};

export type LabRunResult = {
  tenant_id: string;
  agent_slug: string;
  admission?: { allowed: boolean; reason?: string; spent_30d?: number };
  input_blocked?: string[];
  input: { kind: LabInput["kind"]; text?: string; source_run_id?: string; image_count?: number };
  results: LabVariantResult[];
};

export type RunVariantsDeps = {
  sb: SupabaseClient;
  buildContext: (claim: ClaimedAgentRun, runId: string) => Promise<AgentContext>;
  makeDraftCtx: (ctx: AgentContext) => AgentContext;
  runDispatch: (ctx: AgentContext, payload: unknown) => Promise<DispatcherResult>;
  buildCgoFreshPayload: (tenantId: string) => Promise<Record<string, unknown>>;
  cgoNoteReplyMessage: (noteBody: string, reply: string) => string;
  decodeOutboxBody: (body: string) => { text: string };
  noteKeyOfOutboxRow: (row: { run_id?: string | null; idempotency_key?: string | null }) => string | null;
  parseGoalMoves: (text: string) => { ok: true; value: unknown } | { ok: false; reason: string };
  gateMoves?: (runId: string, moves: unknown) => string[];
  newRunId?: () => string;
  timeoutMs?: number;
  fileVariants?: (agentSlug: string) => FileVariant[];
  promptFileExists?: (agentSlug: string, agentFile: string) => boolean;
  loadRecipe?: (channelSlug: string, variantFile?: string) => Pick<ChannelRecipe, "body" | "meta">;
  buildChannelFreshPayload?: (tenantId: string, channelSlug: string) => Promise<Record<string, unknown>>;
  channelAdmission?: (tenantId: string, channelSlug: string) => Promise<{ allowed: boolean; reason?: string; spent_30d?: number }>;
  scrubOutput?: (text: string, agentSlug: string) => string;
  channelCards?: (args: Parameters<typeof labChannelCards>[1]) => Promise<LabCardOutcome>;
};

export class LabInputError extends Error {}

type LabVariant = {
  slug: string;
  label: string;
  variant: ResolvedVariant | null;
  source: "default" | "prod" | "local";
  error?: string;
};

export async function loadLabVariants(
  sb: SupabaseClient,
  slugs: string[],
  files: FileVariant[] = [],
): Promise<LabVariant[]> {
  const uniq = [...new Set(slugs)];
  if (uniq.length === 0) throw new LabInputError("pick at least one variation");
  if (uniq.length > MAX_LAB_VARIANTS) throw new LabInputError(`at most ${MAX_LAB_VARIANTS} variations`);
  const byFile = new Map(files.map((f) => [f.slug, f]));
  const named = uniq.filter((s) => s !== DEFAULT_SLUG && !byFile.has(s));
  const rows = new Map<string, { slug: string; label: string; config: unknown }>();
  if (named.length > 0) {
    const { data, error } = await sb
      .from("agent_engine_variants")
      .select("slug, label, config")
      .in("slug", named)
      .limit(MAX_LAB_VARIANTS);
    if (error) throw new Error(`variant read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ slug: string; label: string; config: unknown }>) rows.set(r.slug, r);
  }
  const missing = named.filter((s) => !rows.has(s));
  if (missing.length) throw new LabInputError(`unknown variation: ${missing.join(", ")}`);
  return uniq.map((slug): LabVariant => {
    if (slug === DEFAULT_SLUG) return { slug, label: "today (default)", variant: DEFAULT_VARIANT, source: "default" };
    const f = byFile.get(slug);
    if (f) {
      return f.config
        ? { slug, label: f.label, variant: { slug, config: f.config }, source: "local" }
        : { slug, label: f.label, variant: null, source: "local", error: f.error };
    }
    const r = rows.get(slug)!;
    const parsed = VariantConfigSchema.safeParse(r.config);
    return parsed.success
      ? { slug, label: r.label, variant: { slug, config: parsed.data }, source: "prod" }
      : { slug, label: r.label, variant: null, source: "prod", error: `invalid config: ${parsed.error.issues[0]?.message ?? "schema"}` };
  });
}

export type ResolvedLabInput = {
  trigger: AgentTrigger;
  payload: Record<string, unknown>;
  images?: LabImage[];
  summary: LabRunResult["input"];
  seedRunId?: string;
};

export function runIdRange(raw: string): { low: string; high: string } | null {
  const hex = raw.trim().toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{6,32}$/.test(hex)) return null;
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { low: fmt(hex.padEnd(32, "0")), high: fmt(hex.padEnd(32, "f")) };
}

function validImages(images: LabImage[] | undefined): LabImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  if (images.length > MAX_LAB_IMAGES) throw new LabInputError(`at most ${MAX_LAB_IMAGES} images`);
  for (const i of images) {
    if (!LAB_IMAGE_MIMES.has(i.mime)) throw new LabInputError(`unsupported image type ${i.mime}`);
    if (typeof i.base64 !== "string" || i.base64.length === 0) throw new LabInputError("empty image");
  }
  return images;
}

function slackTextPayload(text: string): Record<string, unknown> {
  return { source: "slack", slack: { text } };
}

export async function resolveLabInput(
  deps: RunVariantsDeps,
  tenantId: string,
  agentSlug: string,
  input: LabInput,
): Promise<ResolvedLabInput> {
  const sb = deps.sb;
  if ((input.kind === "cgo_latest" || input.kind === "cgo_reply" || input.kind === "cgo_fresh") && agentSlug !== "cgo") {
    throw new LabInputError(`${input.kind} is a cgo input`);
  }
  switch (input.kind) {
    case "operator_text": {
      const text = input.text.trim();
      if (!text) throw new LabInputError("type a question");
      const images = validImages(input.images);
      return {
        trigger: "slack",
        payload: slackTextPayload(text),
        images,
        summary: { kind: input.kind, text, image_count: images?.length ?? 0 },
      };
    }
    case "past_run": {
      const range = runIdRange(input.runId);
      if (!range) throw new LabInputError("run not found");
      const { data, error } = await sb
        .from("agent_runs")
        .select("id, tenant_id, agent_slug, trigger, payload")
        .eq("tenant_id", tenantId)
        .gte("id", range.low)
        .lte("id", range.high)
        .limit(2);
      if (error) throw new Error(`run read failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; tenant_id: string; agent_slug: string; trigger: string; payload: unknown }>;
      if (rows.length === 0) throw new LabInputError("run not found");
      if (rows.length > 1) throw new LabInputError("run id is ambiguous, paste more of it");
      const row = rows[0];
      if (row.tenant_id !== tenantId) throw new LabInputError("run not found");
      if (row.agent_slug !== agentSlug) {
        throw new LabInputError(`that run belongs to ${row.agent_slug}, not ${agentSlug}; pick that agent to replay it`);
      }
      const payload =
        row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      if (row.trigger === "chat") {
        let text = typeof payload.current_message === "string" ? payload.current_message : "";
        for (const k of ["image_paths", "doc_paths", "video_paths"]) {
          if (Array.isArray(payload[k]) && (payload[k] as unknown[]).length > 0) {
            throw new LabInputError("that chat message had attachments, which a replay cannot carry yet");
          }
        }
        if (!text && typeof payload.user_message_id === "string") {
          text = await chatReplayText(sb, tenantId, payload.user_message_id);
        }
        if (!text) throw new LabInputError("that chat run has no question text");
        return { trigger: "slack", payload: slackTextPayload(text), summary: { kind: input.kind, text, source_run_id: row.id } };
      }
      const slackText = (payload.slack as { text?: unknown } | undefined)?.text;
      return {
        trigger: row.trigger as AgentTrigger,
        payload,
        summary: { kind: input.kind, source_run_id: row.id, ...(typeof slackText === "string" ? { text: slackText } : {}) },
      };
    }
    case "cgo_latest": {
      const { data, error } = await sb
        .from("agent_runs")
        .select("id, payload")
        .eq("tenant_id", tenantId)
        .eq("agent_slug", "cgo")
        .eq("payload->>stage", "own_goals")
        .order("enqueued_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`cgo run read failed: ${error.message}`);
      const row = ((data ?? []) as Array<{ id: string; payload: unknown }>)[0];
      if (!row || !row.payload || typeof row.payload !== "object") throw new LabInputError("no goal review found for this tenant");
      return { trigger: "a2a", payload: row.payload as Record<string, unknown>, summary: { kind: input.kind, source_run_id: row.id } };
    }
    case "cgo_reply": {
      const text = input.text.trim();
      if (!text) throw new LabInputError("type the founder's reply");
      const { data, error } = await sb
        .from("slack_outbox")
        .select("body, run_id, idempotency_key")
        .eq("tenant_id", tenantId)
        .eq("kind", "cgo_note")
        .eq("status", "sent")
        .order("enqueued_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`cgo note read failed: ${error.message}`);
      const note = ((data ?? []) as Array<{ body: string; run_id: string | null; idempotency_key: string | null }>)[0];
      if (!note) throw new LabInputError("no sent cgo note to reply to");
      const noteKey = deps.noteKeyOfOutboxRow(note);
      return {
        trigger: "slack",
        payload: {
          source: "slack",
          message: deps.cgoNoteReplyMessage(deps.decodeOutboxBody(note.body).text, text),
          cgo_reply: { via: "slack", ...(noteKey ? { note_key: noteKey } : {}) },
          slack: { text },
        },
        summary: { kind: input.kind, text },
      };
    }
    case "cgo_fresh": {
      const payload = await deps.buildCgoFreshPayload(tenantId);
      return { trigger: "a2a", payload, summary: { kind: input.kind } };
    }
    case "channel_fresh": {
      if (!deps.buildChannelFreshPayload) throw new LabInputError("a fresh channel run is not available here");
      if (agentSlug === "operator" || agentSlug === "cgo") throw new LabInputError("a fresh channel run needs a channel agent");
      const payload = await deps.buildChannelFreshPayload(tenantId, agentSlug);
      const { data, error } = await sb.from("agent_runs").select("id").eq("tenant_id", tenantId).order("enqueued_at", { ascending: false }).limit(1);
      if (error) throw new Error(`run read failed: ${error.message}`);
      const seedRunId = ((data ?? []) as Array<{ id: string }>)[0]?.id;
      return { trigger: "channel_recipe", payload: { ...payload, channel_slug: agentSlug }, summary: { kind: input.kind }, ...(seedRunId ? { seedRunId } : {}) };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      t = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export function summarizeToolCalls(result: DispatcherResult): { calls: LabToolCall[]; blocked: string[] } {
  const calls: LabToolCall[] = (result.tool_calls ?? []).map((c) => {
    const blocked = c.code === LAB_DENY_CODE || (c.output_preview ?? "").includes("blocked in variants lab");
    return {
      name: c.name,
      status: blocked
        ? "blocked"
        : c.status === "ok"
          ? (c.output_preview ?? "").includes('"lab_simulated":true')
            ? "simulated"
            : "ok"
          : "error",
      input_preview: (c.input_preview ?? "").slice(0, blocked ? LAB_BLOCKED_INPUT_CHARS : 300),
      output_preview: c.output_preview ?? "",
      is_error: c.status !== "ok",
      ms: c.ms,
      ...(c.code ? { code: c.code } : {}),
    };
  });
  return { calls, blocked: [...new Set(calls.filter((c) => c.status === "blocked").map((c) => c.name))] };
}

export function labProposals(calls: ReadonlyArray<LabToolCall>): Array<{ tool: string; input: string }> {
  return calls
    .filter((c) => c.status === "blocked")
    .filter((c) => {
      const parts = fromAnthropicName(labBareToolName(c.name));
      if (!parts || LAB_ALWAYS_DENY.has(parts.tool_name)) return false;
      if (LAB_ALWAYS_DENY_FULL.has(`${parts.server_id}__${parts.tool_name}`)) return false;
      try {
        return effectOf(parts.server_id, parts.tool_name) !== "read";
      } catch {
        return false;
      }
    })
    .map((c) => ({ tool: labBareToolName(c.name), input: c.input_preview }));
}

async function runOne(
  deps: RunVariantsDeps,
  tenantId: string,
  agentSlug: string,
  input: ResolvedLabInput,
  v: LabVariant,
): Promise<LabVariantResult> {
  const start = Date.now();
  if (!v.variant) return { slug: v.slug, label: v.label, source: v.source, ok: false, error: v.error, ms: 0 };
  const agentFile = v.variant.config.prompt?.agent_file;
  if (agentFile && !(deps.promptFileExists ?? defaultPromptFileExists)(agentSlug, agentFile)) {
    return {
      slug: v.slug,
      label: v.label,
      source: v.source,
      ok: false,
      error: `prompt file agent.${agentFile}.md not found`,
      ms: 0,
    };
  }
  const runId = (deps.newRunId ?? randomUUID)();
  const payload = structuredClone(input.payload);
  delete payload.memory_mode;
  if (v.variant.config.memory === "off") payload.memory_mode = "off";
  const ch = typeof payload.channel_slug === "string" && /^[a-z0-9_-]{1,40}$/.test(payload.channel_slug) ? payload.channel_slug : agentSlug;
  if (input.trigger === "channel_recipe") {
    try {
      const recipe = (deps.loadRecipe ?? defaultLoadRecipe)(ch, v.variant.config.prompt?.recipe_file);
      payload.recipe_body = recipe.body;
      payload.router = recipe.meta.router;
      payload.inputs = recipe.meta.inputs;
      payload.artifact = recipe.meta.artifact;
      payload.min_evidence = recipe.meta.min_evidence;
    } catch (e) {
      return { slug: v.slug, label: v.label, source: v.source, ok: false, error: `recipe: ${(e as Error).message}`, ms: 0 };
    }
  } else if (v.variant.config.prompt?.recipe_file) {
    return { slug: v.slug, label: v.label, source: v.source, ok: false, error: "recipe_file only applies to a replayed channel run", ms: 0 };
  }
  const ctx = await deps.buildContext(
    { id: runId, tenant_id: tenantId, agent_slug: agentSlug, trigger: input.trigger, payload },
    runId,
  );
  if (ctx.tenant_id !== tenantId) throw new Error("context tenant mismatch");
  const lab = deps.makeDraftCtx(ctx);
  lab.draft_mode = true;
  lab.variants_lab = true;
  lab.variant_override = v.variant;
  if (input.images) lab.lab_user_images = input.images;
  const abort = new AbortController();
  lab.lab_abort = abort.signal;
  const dispatched = deps.runDispatch(lab, payload);
  dispatched.catch(() => undefined);
  void dispatched.then(
    () => releaseRunFigures(runId, null),
    () => releaseRunFigures(runId, null),
  );
  const r = await withTimeout(
    dispatched,
    deps.timeoutMs ?? (input.trigger === "channel_recipe" ? LAB_CHANNEL_TIMEOUT_MS : LAB_VARIANT_TIMEOUT_MS),
    () => abort.abort(),
  );
  const { calls, blocked } = summarizeToolCalls(r);
  const out: LabVariantResult = {
    slug: v.slug,
    label: v.label,
    source: v.source,
    ok: true,
    output_text: r.output_text,
    tool_calls: calls,
    blocked,
    tokens: {
      input: r.usage?.input_tokens ?? 0,
      output: r.usage?.output_tokens ?? 0,
      cache_read: r.usage?.cache_read_input_tokens,
      cache_write: r.usage?.cache_creation_input_tokens,
    },
    cost_usd: r.usage?.cost_usd ?? null,
    ms: Date.now() - start,
  };
  if (r.prompt_snapshot) out.prompt_snapshot = r.prompt_snapshot;
  if (lab.resolved_variant) {
    out.resolved_slug = lab.resolved_variant.slug;
    out.ran_as_default = v.variant.slug !== null && lab.resolved_variant.slug !== v.variant.slug;
  }
  if (r.parsed != null) out.would_file = r.parsed;
  const simulated = [...new Set(calls.filter((c) => c.status === "simulated").map((c) => labBareToolName(c.name)))];
  if (simulated.length) out.simulated = simulated;
  if (lab.lab_engine) {
    out.model = lab.lab_engine.model;
    if (lab.lab_engine.effort) out.effort = lab.lab_engine.effort;
  }
  if (r.stop_reason) out.stop_reason = r.stop_reason;
  if (r.side_effect) out.side_effect = { kind: r.side_effect.kind, ...(r.side_effect.reason ? { reason: r.side_effect.reason } : {}) };
  if (deps.scrubOutput && r.output_text) {
    const visible = deps.scrubOutput(r.output_text, agentSlug);
    if (visible !== r.output_text) out.visible_text = visible;
  }
  out.parse_ok = r.parse_ok === true;
  if (r.parse_error) out.parse_error = String(r.parse_error).slice(0, 500);
  if (input.trigger === "channel_recipe") {
    const sourceRunId = input.summary.source_run_id ?? input.seedRunId;
    if (!out.parse_ok) out.no_cards_reason = "parse_failed";
    else if (r.parsed == null) {
      const se = r.side_effect as { kind?: string; reason?: unknown } | undefined;
      out.no_cards_reason = se?.kind === "refused" ? `suppressed: ${String(se.reason ?? "")}`.slice(0, 300) : "no_output";
    } else if (!sourceRunId) out.no_cards_reason = "no source run";
    else {
      const cards = await (deps.channelCards ?? ((a) => labChannelCards(deps.sb, a)))({
        tenantId,
        channelSlug: ch,
        runId,
        sourceRunId,
        envelope: r.parsed,
        proposals: labProposals(calls),
        payload,
      });
      if (cards.ok) out.cards = cards.value;
      else out.no_cards_reason = cards.reason;
    }
    const proposals = labProposals(calls);
    if (proposals.length) out.proposals = proposals;
  }
  if (agentSlug === "cgo") {
    const moves = deps.parseGoalMoves(r.raw_response_text || r.output_text || "");
    if (moves.ok) {
      out.moves = moves.value;
      const refused = deps.gateMoves?.(runId, moves.value) ?? [];
      if (refused.length) out.moves_refused = refused;
    } else out.moves_error = moves.reason;
  }
  return out;
}

export async function runVariants(args: {
  tenantId: string;
  agentSlug: string;
  input: LabInput;
  variantSlugs: string[];
  deps: RunVariantsDeps;
}): Promise<LabRunResult> {
  const { tenantId, agentSlug, input, deps } = args;
  const variants = await loadLabVariants(deps.sb, args.variantSlugs, deps.fileVariants?.(agentSlug) ?? []);
  let inputBlocked: string[] = [];
  const resolved = await withLabDbWriteLog(async (log) => {
    try {
      return await resolveLabInput(deps, tenantId, agentSlug, input);
    } finally {
      inputBlocked = [...new Set(log)];
    }
  });
  const admission =
    resolved.trigger === "channel_recipe" && deps.channelAdmission
      ? await deps.channelAdmission(tenantId, agentSlug).catch((e) => ({ allowed: false, reason: `check failed: ${(e as Error).message}` }))
      : undefined;
  const readCache = newLabReadCache();
  const settled = await Promise.allSettled(
    variants.map((v) =>
      withLabReadCache(readCache, () => withLabDbWriteLog(async (log) => {
        try {
          const r = await runOne(deps, tenantId, agentSlug, resolved, v);
          return log.length ? { ...r, blocked_db_writes: [...new Set(log)] } : r;
        } catch (e) {
          if (log.length) (e as { blocked_db_writes?: string[] }).blocked_db_writes = [...new Set(log)];
          throw e;
        }
      })),
    ),
  );
  return {
    tenant_id: tenantId,
    agent_slug: agentSlug,
    ...(admission ? { admission } : {}),
    ...(inputBlocked.length ? { input_blocked: inputBlocked } : {}),
    input: resolved.summary,
    results: settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : {
            slug: variants[i].slug,
            label: variants[i].label,
            source: variants[i].source,
            ok: false,
            error: (s.reason as Error)?.message ?? String(s.reason),
            ...((s.reason as { blocked_db_writes?: string[] })?.blocked_db_writes
              ? { blocked_db_writes: (s.reason as { blocked_db_writes: string[] }).blocked_db_writes }
              : {}),
            ms: 0,
          },
    ),
  };
}

export async function defaultRunVariantsDeps(sb: SupabaseClient): Promise<RunVariantsDeps> {
  const runner = await import("../runner");
  const { makeDraftCtx } = await import("../generic-dispatcher");
  const goalOwner = await import("@/services/growth/goal-owner");
  const numberGate = await import("@/services/growth/number-gate");
  const reply = await import("@/services/slack/cgo-note-reply");
  const { decodeOutboxBody } = await import("@/services/slack/outbox-body");
  const scrub = await import("../scrub-agent-egress");
  return {
    sb,
    buildContext: runner.buildContext,
    makeDraftCtx,
    runDispatch: runner.runDispatch,
    buildCgoFreshPayload: async (tenantId) => {
      const goals = await goalOwner.loadActiveGoals(tenantId);
      if (goals.length === 0) throw new LabInputError("this tenant has no active goal");
      const { getBoolSettingStrictResolved } = await import("@/services/settings");
      const autopilot = await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenantId);
      return goalOwner.buildGoalOwnerPayload({ tenant_id: tenantId, reason: "goal_set" }, autopilot, new Date());
    },
    cgoNoteReplyMessage: reply.cgoNoteReplyMessage,
    decodeOutboxBody,
    noteKeyOfOutboxRow: reply.noteKeyOfOutboxRow,
    parseGoalMoves: goalOwner.parseGoalMoves,
    gateMoves: (runId, moves) =>
      numberGate.gateMovesOnLedger(runId, moves as Parameters<typeof numberGate.gateMovesOnLedger>[1]).refused,
    channelAdmission: async (tenantId, channelSlug) => {
      const { channelBudgetAllows } = await import("@/services/channels/budget");
      const { reserveEstimateFor } = await import("@/services/agents/credits");
      const v = await channelBudgetAllows(tenantId, reserveEstimateFor(loadChannelRecipe(channelSlug).meta.executor));
      return v.allowed ? { allowed: true, spent_30d: v.spent_30d } : { allowed: false, reason: v.reason, spent_30d: v.spent_30d };
    },
    scrubOutput: (text, agentSlug) => scrub.scrubAgentEgress(text, { surface: "persist", agentSlug }).text,
    buildChannelFreshPayload: async (tenantId, channelSlug) => {
      const { defaultChannelContext } = await import("@/services/channels/context");
      const { readPendingProposals } = await import("@/services/channels/engine");
      const recipe = loadChannelRecipe(channelSlug);
      const [context, pending_proposals] = await Promise.all([
        defaultChannelContext(tenantId, channelSlug).catch(() => null),
        readPendingProposals(tenantId, recipe.meta.executor),
      ]);
      return { ...(context ?? {}), ...(pending_proposals.length > 0 ? { pending_proposals } : {}) };
    },
    fileVariants: (agentSlug) => loadFileVariants(agentSlug),
  };
}
