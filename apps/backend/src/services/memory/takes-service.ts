
import { serviceClient } from "@/services/supabase";
import { roundWeight, computeScorecardMetrics, type Resolution, type ScorecardMetrics } from "./takes";
import { scrubClaim } from "./takes-scrub";

export type HolderType = "tenant" | "agent" | "user" | "entity";
export type TakeKind = "fact" | "take" | "bet" | "hunch";
export type ResolvedTo = "correct" | "incorrect" | "partial";

const VALID_RESOLVED_TO: ReadonlySet<ResolvedTo> = new Set([
  "correct",
  "incorrect",
  "partial",
]);

export class InvalidResolvedToError extends Error {
  constructor(value: unknown) {
    super(`resolveBet: invalid resolved_to ${JSON.stringify(value)}`);
    this.name = "InvalidResolvedToError";
  }
}
export type ResolutionSource = "manual" | "staff" | "auto" | "agent_self_reported";

export type WriteTakeInput = {
  holder_type: HolderType;
  holder_ref?: string | null;
  kind: TakeKind;
  claim: string;
  weight: number;
  subject_entity_id?: string | null;
  source_note_id?: string | null;
  source_run_id?: string | null;
};

export type TakeRow = {
  id: number;
  tenant_id: string;
  holder_type: HolderType;
  holder_ref: string | null;
  kind: TakeKind;
  subject_entity_id: string | null;
  claim: string;
  weight: number;
  source_note_id: string | null;
  source_run_id: string | null;
  resolved_at: string | null;
  resolved_to: ResolvedTo | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
  resolution_source: ResolutionSource | null;
  created_at: string;
  updated_at: string;
};

export class HolderInvariantError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HolderInvariantError";
  }
}
export class CrossTenantSubjectError extends Error {
  constructor() {
    super("subject_entity_id belongs to a different tenant");
    this.name = "CrossTenantSubjectError";
  }
}
export class BetNotFoundError extends Error {
  constructor(take_id: number) {
    super(`bet ${take_id} not found in tenant`);
    this.name = "BetNotFoundError";
  }
}
export class BetOnlyError extends Error {
  constructor() {
    super("resolveBet only applies to kind='bet' rows");
    this.name = "BetOnlyError";
  }
}
export class ResolutionConflictError extends Error {
  constructor(existing: ResolvedTo, attempted: ResolvedTo) {
    super(`bet already resolved to '${existing}'; cannot re-resolve to '${attempted}'`);
    this.name = "ResolutionConflictError";
  }
}

function validateHolderInvariant(holder_type: HolderType, holder_ref: string | null | undefined): void {
  if (holder_type === "tenant") {
    if (holder_ref !== null && holder_ref !== undefined) {
      throw new HolderInvariantError("holder_type='tenant' must have holder_ref=null");
    }
    return;
  }
  if (!holder_ref || holder_ref.length === 0) {
    throw new HolderInvariantError(`holder_type='${holder_type}' requires non-empty holder_ref`);
  }
  if (holder_ref.length > 200) {
    throw new HolderInvariantError(`holder_ref length ${holder_ref.length} exceeds 200`);
  }
}

export async function writeTake(
  tenant_id: string,
  input: WriteTakeInput,
): Promise<{ take_id: number }> {
  validateHolderInvariant(input.holder_type, input.holder_ref ?? null);

  if (!input.claim || typeof input.claim !== "string") {
    throw new Error("claim must be a non-empty string");
  }
  const scrubbed = scrubClaim(input.claim);
  if (scrubbed.length === 0) {
    throw new Error("claim is empty after scrubbing");
  }
  const weight = roundWeight(input.weight);

  const sb = serviceClient();

  if (input.subject_entity_id) {
    const { data: ent } = await sb
      .from("memory_entity")
      .select("tenant_id")
      .eq("id", input.subject_entity_id)
      .maybeSingle();
    if (!ent || (ent as { tenant_id: string }).tenant_id !== tenant_id) {
      throw new CrossTenantSubjectError();
    }
  }

  const row = {
    tenant_id,
    holder_type: input.holder_type,
    holder_ref: input.holder_type === "tenant" ? null : input.holder_ref,
    kind: input.kind,
    subject_entity_id: input.subject_entity_id ?? null,
    claim: scrubbed,
    weight,
    source_note_id: input.source_note_id ?? null,
    source_run_id: input.source_run_id ?? null,
  };

  const { data, error } = await sb.from("takes").insert(row).select("id").single();
  if (error || !data) {
    throw new Error(`takes insert failed: ${error?.message ?? "no row"}`);
  }
  return { take_id: (data as { id: number }).id };
}

export type ResolveBetInput = {
  resolved_to: ResolvedTo;
  resolved_by_user_id?: string | null;
  resolution_note?: string | null;
  resolution_source?: ResolutionSource;
};

export async function resolveBet(
  tenant_id: string,
  take_id: number,
  opts: ResolveBetInput,
): Promise<void> {
  if (!VALID_RESOLVED_TO.has(opts.resolved_to)) {
    throw new InvalidResolvedToError(opts.resolved_to);
  }
  const sb = serviceClient();
  const now = new Date().toISOString();
  const scrubbedNote = opts.resolution_note ? scrubClaim(opts.resolution_note).slice(0, 500) : null;

  const { data: updated, error } = await sb
    .from("takes")
    .update({
      resolved_at: now,
      resolved_to: opts.resolved_to,
      resolved_by_user_id: opts.resolved_by_user_id ?? null,
      resolution_note: scrubbedNote,
      resolution_source: opts.resolution_source ?? "manual",
      updated_at: now,
    })
    .eq("tenant_id", tenant_id)
    .eq("id", take_id)
    .eq("kind", "bet")
    .or(`resolved_to.is.null,resolved_to.eq.${opts.resolved_to}`)
    .select("id, resolved_to")
    .maybeSingle();

  if (error) throw new Error(`resolveBet update failed: ${error.message}`);

  if (updated) return;

  const { data: existing } = await sb
    .from("takes")
    .select("id, kind, resolved_to")
    .eq("tenant_id", tenant_id)
    .eq("id", take_id)
    .maybeSingle();

  if (!existing) throw new BetNotFoundError(take_id);
  const r = existing as { kind: TakeKind; resolved_to: ResolvedTo | null };
  if (r.kind !== "bet") throw new BetOnlyError();
  if (r.resolved_to && r.resolved_to !== opts.resolved_to) {
    throw new ResolutionConflictError(r.resolved_to, opts.resolved_to);
  }
  throw new BetNotFoundError(take_id);
}

const AGENT_TAKE_ALLOWLIST: ReadonlySet<string> = new Set([
  "chief-of-staff",
  "pm",
]);

const AGENT_TAKE_DEFAULT_WEIGHT = 0.7;

const AGENT_TAKE_CLAIM_FIELDS = ["summary", "headline", "title", "decision"] as const;

function extractClaimText(
  parsed: unknown,
  output_text: string,
): string | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const f of AGENT_TAKE_CLAIM_FIELDS) {
      const v = obj[f];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  if (typeof output_text === "string" && output_text.trim().length > 0) {
    return output_text.slice(0, 500);
  }
  return null;
}

export async function recordAgentTake(
  tenant_id: string,
  agent_slug: string,
  run_id: string,
  result: { parsed?: unknown; output_text?: string } | null,
): Promise<{ take_id: number | null; skipped?: string }> {
  if (!AGENT_TAKE_ALLOWLIST.has(agent_slug)) {
    return { take_id: null, skipped: "not_in_allowlist" };
  }
  if (!result || (!result.output_text && !result.parsed)) {
    return { take_id: null, skipped: "no_result_content" };
  }
  const rawClaim = extractClaimText(result.parsed, result.output_text ?? "");
  if (!rawClaim) return { take_id: null, skipped: "no_claim_text" };
  const truncated = rawClaim.slice(0, 1000);
  try {
    const { take_id } = await writeTake(tenant_id, {
      holder_type: "agent",
      holder_ref: agent_slug,
      kind: "take",
      claim: truncated,
      weight: AGENT_TAKE_DEFAULT_WEIGHT,
      source_run_id: run_id,
    });
    return { take_id };
  } catch (err) {
    console.warn(
      `[recordAgentTake] write failed for ${agent_slug}/${run_id}: ${(err as Error).message}`,
    );
    return { take_id: null, skipped: "write_failed" };
  }
}

export type ListTakesFilters = {
  holder_type?: HolderType;
  holder_ref?: string;
  kind?: TakeKind;
  subject_entity_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};

export async function listTakes(
  tenant_id: string,
  filters: ListTakesFilters = {},
): Promise<TakeRow[]> {
  let q = serviceClient()
    .from("takes")
    .select("*")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(Math.min(filters.limit ?? 100, 500));
  if (filters.holder_type) q = q.eq("holder_type", filters.holder_type);
  if (filters.holder_ref) q = q.eq("holder_ref", filters.holder_ref);
  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.subject_entity_id) q = q.eq("subject_entity_id", filters.subject_entity_id);
  if (filters.since) q = q.gte("created_at", filters.since);
  if (filters.until) q = q.lte("created_at", filters.until);
  if (filters.offset) q = q.range(filters.offset, filters.offset + (filters.limit ?? 100) - 1);
  const { data, error } = await q;
  if (error) throw new Error(`listTakes failed: ${error.message}`);
  return (data ?? []) as TakeRow[];
}

export type ScorecardOpts = {
  holder_type?: HolderType;
  holder_ref?: string;
  since?: string;
  until?: string;
};

export async function computeScorecard(
  tenant_id: string,
  opts: ScorecardOpts = {},
): Promise<ScorecardMetrics> {
  const sb = serviceClient();
  const since =
    opts.since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const until = opts.until ?? new Date().toISOString();

  let q = sb
    .from("takes")
    .select("weight, resolved_to")
    .eq("tenant_id", tenant_id)
    .eq("kind", "bet")
    .not("resolved_to", "is", null)
    .gte("created_at", since)
    .lte("created_at", until)
    .limit(50000);
  if (opts.holder_type) q = q.eq("holder_type", opts.holder_type);
  if (opts.holder_ref) q = q.eq("holder_ref", opts.holder_ref);

  const { data, error } = await q;
  if (error) throw new Error(`computeScorecard failed: ${error.message}`);
  const resolutions = ((data ?? []) as Array<{ weight: number; resolved_to: ResolvedTo }>).map(
    (r) => ({ weight: Number(r.weight), resolved_to: r.resolved_to }) as Resolution,
  );
  return computeScorecardMetrics(resolutions);
}
