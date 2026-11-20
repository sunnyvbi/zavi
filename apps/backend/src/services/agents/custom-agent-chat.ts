
import crypto from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { webBaseUrl } from "@/services/web-base";
import { refusalFor } from "./refusal";
import { tierRank } from "@/services/billing/tiers";
import { scheduleLabel } from "./custom-agent-schedule-label";
import {
  customAgentDraftSchema,
  customAgentNameNorm,
  customAgentReservedNames,
  instructionsRejection,
  isReservedCustomAgentName,
  resolveCustomTriggers,
  type CustomAgentDraft,
  type CustomTrigger,
} from "./custom-agents";

export function customAgentPausedReply(name: string): string {
  return `${name} is paused. Resume it on its Agent Builder page.`;
}

export const WHATSAPP_NOT_OWNER_REPLY =
  "Only the workspace owner's verified number can create agents on WhatsApp. Ask your owner, or create it in Zavi or Slack.";

export const CONFIRM_EXPIRED_REPLY = "This confirm has expired. Ask Zavi to draft the agent again.";
export const CONFIRM_USED_REPLY = "This was already confirmed.";
export const CONFIRM_INVALID_REPLY = "This confirm is not valid. Ask Zavi to draft the agent again.";
export const CONFIRM_WRONG_PERSON_REPLY = "Only the person who asked for this agent can confirm it.";
export const CONFIRM_FAILED_REPLY = "Something went wrong creating the agent. Please try again.";
export const CONFIRM_RELEASE_FAILED_REPLY = "Something went wrong. Ask Zavi to draft the agent again.";
export const NAME_TAKEN_REPLY =
  "You already have an agent with that name. Ask Zavi to draft it again with another name.";
export const NAME_RESERVED_REPLY =
  "That name belongs to a built-in agent. Ask Zavi to draft it again with another name.";
export const GENERIC_RETRY_REPLY = "Something went wrong. Please try again.";

export const CUSTOM_AGENT_REAL_CHANGES_WARNING =
  "Works on its own and can use any tool your workspace has. Anything it does happens for real.";

export function customAgentPageUrl(agent_id: string): string {
  return `${webBaseUrl()}/workspace?tab=agent-builder&agent=${encodeURIComponent(agent_id)}`;
}

export function billingUrl(): string {
  return `${webBaseUrl()}/workspace?tab=settings#billing`;
}

export function planRefusalText(): string {
  return `${refusalFor({ kind: "custom_agents_plan" }).message} Upgrade here: ${billingUrl()}`;
}

export type MentionableAgent = { id: string; slug: string; name: string; status: string };

const MENTION_MAX_WORDS = 12;

export function stripLeadingSlackMentions(text: string): string {
  return text.replace(/^(\s*<@[A-Z0-9]+(?:\|[^>]*)?>)+/i, "").trimStart();
}

export function matchCustomAgentMention<A extends { name: string }>(
  text: string,
  agents: readonly A[],
): { agent: A; task: string } | null {
  const t = stripLeadingSlackMentions(String(text ?? ""));
  if (!t.startsWith("@") || agents.length === 0) return null;
  const body = t.slice(1);
  const byNorm = new Map<string, A>();
  for (const a of agents) {
    const n = customAgentNameNorm(a.name);
    if (n) byNorm.set(n, a);
  }
  const words = [...body.matchAll(/\S+/g)];
  for (let k = Math.min(words.length, MENTION_MAX_WORDS); k >= 1; k--) {
    const last = words[k - 1];
    const end = (last.index ?? 0) + last[0].length;
    const hit = byNorm.get(customAgentNameNorm(body.slice(0, end)));
    if (hit) return { agent: hit, task: body.slice(end).replace(/^[\s:,.-]+/, "").trim() };
  }
  return null;
}

export type MentionResolution =
  | { kind: "run"; agent: MentionableAgent; task: string }
  | { kind: "paused"; agent: MentionableAgent };

export async function loadMentionableAgents(tenant_id: string): Promise<MentionableAgent[]> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agents")
      .select("id, slug, name, status")
      .neq("status", "archived");
    if (error || !data) return [];
    return data as MentionableAgent[];
  } catch {
    return [];
  }
}

export async function resolveCustomAgentMention(
  tenant_id: string,
  text: string,
  load: (tenant_id: string) => Promise<MentionableAgent[]> = loadMentionableAgents,
): Promise<MentionResolution | null> {
  if (!tenant_id || !stripLeadingSlackMentions(String(text ?? "")).startsWith("@")) return null;
  const hit = matchCustomAgentMention(text, await load(tenant_id));
  if (!hit) return null;
  if (hit.agent.status === "active") return { kind: "run", agent: hit.agent, task: hit.task };
  if (hit.agent.status === "paused") return { kind: "paused", agent: hit.agent };
  return null;
}

export function customMentionTask(task: string): string {
  return task.length > 0
    ? task
    : "Someone addressed you by name without a request. Do your job once now, as your instructions say, and report the result.";
}

export const CUSTOM_CONFIRM_TTL_MS = 30 * 60 * 1000;
export const SLACK_ACTION_CUSTOM_AGENT_CONFIRM = "custom_agent_confirm";
export const WA_CONFIRM_BUTTON_PREFIX = "cac:";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CONFIRM_CODE_RE = /^[A-Z2-9]{8}$/;

export function makeConfirmCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function customAgentDraftHash(draft: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(draft)).digest("hex");
}

export function confirmButtonValue(code: string, hash: string): string {
  return `${code}:${hash}`;
}

export function parseConfirmButtonValue(v: string): { code: string; hash: string } | null {
  const m = /^([A-Z2-9]{8}):([0-9a-f]{64})$/.exec(String(v ?? "").trim());
  return m ? { code: m[1], hash: m[2] } : null;
}

export async function confirmCodeIssued(tenant_id: string, code: string, surface: ConfirmSurface): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agent_confirm_tokens")
      .select("id")
      .eq("code", code)
      .eq("surface", surface)
      .limit(1);
    return error ? true : Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

export function parseConfirmText(text: string): string | null {
  const m = /^\s*confirm\s+([A-Za-z2-9]{8})\s*[.!]?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const code = m[1].toUpperCase();
  return CONFIRM_CODE_RE.test(code) ? code : null;
}

export type ConfirmSurface = "slack" | "whatsapp";
export type ConfirmAction = "create" | "update";

export type ConfirmTokenRow = {
  id: string;
  tenant_id: string;
  code: string;
  surface: ConfirmSurface;
  external_user_id: string;
  slack_team_id: string | null;
  phone_number_id: string | null;
  action: ConfirmAction;
  agent_id: string | null;
  draft: unknown;
  draft_hash: string;
  origin: unknown;
  origin_run_id: string | null;
  expires_at: string;
  consumed_at: string | null;
};

const TOKEN_COLUMNS =
  "id, tenant_id, code, surface, external_user_id, slack_team_id, phone_number_id, action, agent_id, draft, draft_hash, origin, origin_run_id, expires_at, consumed_at";

export type IssueConfirmInput = {
  tenant_id: string;
  surface: ConfirmSurface;
  external_user_id: string;
  slack_team_id?: string | null;
  phone_number_id?: string | null;
  action: ConfirmAction;
  agent_id?: string | null;
  draft: CustomAgentDraft;
  origin: Record<string, unknown>;
  origin_run_id?: string | null;
};

export async function issueCustomAgentConfirm(
  input: IssueConfirmInput,
  now: Date = new Date(),
): Promise<{ code: string; draft_hash: string; expires_at: string }> {
  const draft_hash = customAgentDraftHash(input.draft);
  const expires_at = new Date(now.getTime() + CUSTOM_CONFIRM_TTL_MS).toISOString();
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = makeConfirmCode();
    const { error } = await tenantClient(asTenantId(input.tenant_id))
      .from("custom_agent_confirm_tokens")
      .insert({
        code,
        surface: input.surface,
        external_user_id: input.external_user_id,
        slack_team_id: input.surface === "slack" ? (input.slack_team_id ?? null) : null,
        phone_number_id: input.surface === "whatsapp" ? (input.phone_number_id ?? null) : null,
        action: input.action,
        agent_id: input.action === "update" ? (input.agent_id ?? null) : null,
        draft: input.draft,
        draft_hash,
        origin: input.origin,
        origin_run_id: input.origin_run_id ?? null,
        expires_at,
      });
    if (!error) return { code, draft_hash, expires_at };
    lastErr = error.message ?? "insert failed";
    if (!/duplicate|unique/i.test(lastErr)) break;
  }
  throw new Error(`custom agent confirm could not be stored: ${lastErr}`);
}

export type ConsumeConfirmInput = {
  code: string;
  surface: ConfirmSurface;
  external_user_id: string;
  slack_team_id?: string | null;
  phone_number_id?: string | null;
  draft_hash?: string | null;
};

export type ConsumeConfirmResult =
  | { ok: true; token: ConfirmTokenRow }
  | { ok: false; reason: "used"; token: ConfirmTokenRow }
  | { ok: false; reason: "not_found" | "expired" | "wrong_user" | "wrong_team" | "draft_mismatch" };

export async function consumeCustomAgentConfirm(
  tenant_id: string,
  input: ConsumeConfirmInput,
  now: Date = new Date(),
): Promise<ConsumeConfirmResult> {
  if (!CONFIRM_CODE_RE.test(input.code)) return { ok: false, reason: "not_found" };
  const tc = tenantClient(asTenantId(tenant_id));
  const { data, error } = await tc
    .from("custom_agent_confirm_tokens")
    .select(TOKEN_COLUMNS)
    .eq("code", input.code)
    .maybeSingle<ConfirmTokenRow>();
  if (error || !data) return { ok: false, reason: "not_found" };
  const row = data;
  if (row.surface !== input.surface) return { ok: false, reason: "not_found" };
  if (row.surface === "slack" && row.slack_team_id !== (input.slack_team_id ?? null)) {
    return { ok: false, reason: "wrong_team" };
  }
  if (row.surface === "whatsapp" && row.phone_number_id !== (input.phone_number_id ?? null)) {
    return { ok: false, reason: "wrong_user" };
  }
  if (row.external_user_id !== input.external_user_id) return { ok: false, reason: "wrong_user" };
  if (customAgentDraftHash(row.draft) !== row.draft_hash) return { ok: false, reason: "draft_mismatch" };
  if (input.draft_hash != null && input.draft_hash !== row.draft_hash) {
    return { ok: false, reason: "draft_mismatch" };
  }
  if (row.consumed_at) return { ok: false, reason: "used", token: row };
  const nowIso = now.toISOString();
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };

  const { data: claimed, error: claimErr } = await tc
    .from("custom_agent_confirm_tokens")
    .update({ consumed_at: nowIso })
    .eq("id", row.id)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select(TOKEN_COLUMNS);
  if (claimErr) return { ok: false, reason: "not_found" };
  const won = (claimed ?? []) as ConfirmTokenRow[];
  if (won.length !== 1) return { ok: false, reason: "used", token: row };
  return { ok: true, token: won[0] };
}

export async function releaseCustomAgentConfirm(tenant_id: string, token_id: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agent_confirm_tokens")
    .update({ consumed_at: null })
    .eq("id", token_id);
  if (error) throw new Error(`custom agent confirm release failed: ${error.message}`);
}

export type ConfirmTriggerRow = {
  kind: string;
  cron: string | null;
  tz: string | null;
  interval_minutes: number | null;
  condition: string | null;
};

export type ConfirmAgentRow = {
  id: string;
  name: string;
  role: string | null;
  instructions: string;
  origin_run_id: string | null;
  tools: unknown;
  default_deliver: unknown;
  triggers: ConfirmTriggerRow[];
};

export async function findAgentForConfirm(token: ConfirmTokenRow): Promise<ConfirmAgentRow | null> {
  try {
    const db = tenantClient(asTenantId(token.tenant_id));
    const q = db
      .from("custom_agents")
      .select("id, name, role, instructions, origin_run_id, tools, default_deliver")
      .neq("status", "archived");
    type AgentOnly = Omit<ConfirmAgentRow, "triggers">;
    let agent: AgentOnly | null = null;
    if (token.action === "update") {
      if (!token.agent_id) return null;
      const { data, error } = await q.eq("id", token.agent_id).maybeSingle<AgentOnly>();
      if (error) return null;
      agent = data ?? null;
    } else {
      if (!token.origin_run_id) return null;
      const { data, error } = await q.eq("origin_run_id", token.origin_run_id).maybeSingle<AgentOnly>();
      if (error) return null;
      agent = data ?? null;
    }
    if (!agent) return null;
    const { data: trig, error: tErr } = await db
      .from("custom_agent_triggers")
      .select("kind, cron, tz, interval_minutes, condition")
      .eq("agent_id", agent.id);
    if (tErr) return null;
    return { ...agent, triggers: (trig ?? []) as ConfirmTriggerRow[] };
  } catch {
    return null;
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function triggerKey(t: { kind: string; cron?: string | null; tz?: string | null; interval_minutes?: number | null; condition?: string | null }): string {
  return t.kind === "schedule"
    ? `schedule|${(t.cron ?? "").trim()}|${t.tz ?? ""}`
    : `watch|${t.interval_minutes ?? ""}|${t.condition ?? ""}`;
}

export function agentMatchesConfirm(row: ConfirmAgentRow, token: ConfirmTokenRow): boolean {
  const parsed = customAgentDraftSchema.safeParse(token.draft);
  if (!parsed.success) return false;
  const d = parsed.data;
  if (token.action === "create") {
    if (!token.origin_run_id || row.origin_run_id !== token.origin_run_id) return false;
    if (canonical(row.default_deliver ?? null) !== canonical(d.deliver ?? null)) return false;
  }
  const resolved = resolveCustomTriggers(d.triggers as CustomTrigger[], "UTC");
  if (!resolved.ok) return false;
  const want = resolved.triggers.map(triggerKey).sort();
  const have = (row.triggers ?? []).map(triggerKey).sort();
  const sortedTools = (t: unknown) => canonical(Array.isArray(t) ? [...t].map(String).sort() : t);
  return (
    customAgentNameNorm(row.name) === customAgentNameNorm(d.name) &&
    (row.role ?? "").trim() === (d.role ?? "").trim() &&
    (row.instructions ?? "").trim() === d.instructions.trim() &&
    sortedTools(row.tools ?? []) === sortedTools(d.tools ?? []) &&
    want.length === have.length &&
    want.every((k, i) => k === have[i])
  );
}

async function confirmAppliedAgent(
  token: ConfirmTokenRow,
  find: (t: ConfirmTokenRow) => Promise<ConfirmAgentRow | null>,
): Promise<ConfirmAgentRow | null> {
  const row = await find(token).catch(() => null);
  return row && agentMatchesConfirm(row, token) ? row : null;
}

export function confirmSuccessText(action: ConfirmAction, agent_id: string): string {
  return action === "create"
    ? `Agent created. Open it in Agent Builder: ${customAgentPageUrl(agent_id)}`
    : `Agent updated. Open it in Agent Builder: ${customAgentPageUrl(agent_id)}`;
}

export type RunConfirmDeps = {
  consume: typeof consumeCustomAgentConfirm;
  apply: (token: ConfirmTokenRow, creator: { created_by: string | null; slack_user_id: string | null }) => Promise<ApplyConfirmResult>;
  release: typeof releaseCustomAgentConfirm;
  findAgent: typeof findAgentForConfirm;
};

export async function runCustomAgentConfirm(
  tenant_id: string,
  input: ConsumeConfirmInput,
  creator: { created_by: string | null; slack_user_id: string | null },
  deps?: Partial<RunConfirmDeps>,
): Promise<{ ok: boolean; text: string }> {
  const d: RunConfirmDeps = {
    consume: consumeCustomAgentConfirm,
    apply: (t, c) => applyCustomAgentConfirm(t, c),
    release: releaseCustomAgentConfirm,
    findAgent: findAgentForConfirm,
    ...deps,
  };
  const consumed = await d.consume(tenant_id, input);
  if (!consumed.ok) {
    if (consumed.reason === "used" && consumed.token.consumed_at) {
      const agent = await confirmAppliedAgent(consumed.token, d.findAgent);
      if (agent) return { ok: true, text: confirmSuccessText(consumed.token.action, agent.id) };
    }
    return { ok: false, text: consumeRejectionText(consumed.reason) };
  }
  const token = consumed.token;
  let applied: ApplyConfirmResult;
  try {
    applied = await d.apply(token, creator);
  } catch {
    applied = { ok: false, text: CONFIRM_FAILED_REPLY };
  }
  if (applied.ok) return { ok: true, text: applied.text };
  if (token.action === "create") {
    const agent = await confirmAppliedAgent(token, d.findAgent);
    if (agent) return { ok: true, text: confirmSuccessText("create", agent.id) };
  }
  try {
    await d.release(tenant_id, token.id);
  } catch (e) {
    console.warn(`[custom-agent-chat] ${(e as Error).message}`);
    return { ok: false, text: CONFIRM_RELEASE_FAILED_REPLY };
  }
  return { ok: false, text: applied.text };
}

export function consumeRejectionText(reason: Exclude<ConsumeConfirmResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "expired":
      return CONFIRM_EXPIRED_REPLY;
    case "used":
      return CONFIRM_USED_REPLY;
    case "wrong_user":
      return CONFIRM_WRONG_PERSON_REPLY;
    default:
      return CONFIRM_INVALID_REPLY;
  }
}

export async function whatsappOwnerUserId(
  tenant_id: string,
  phone_number_id: string,
  wa_id: string,
): Promise<string | null> {
  try {
    const tc = tenantClient(asTenantId(tenant_id));
    const { data: thread, error } = await tc
      .from("whatsapp_threads")
      .select("bound_by_user_id, status")
      .eq("phone_number_id", phone_number_id)
      .eq("wa_id", wa_id)
      .maybeSingle<{ bound_by_user_id: string | null; status: string }>();
    if (error || !thread || thread.status !== "enabled" || !thread.bound_by_user_id) return null;
    const { data: member, error: mErr } = await tc
      .from("tenant_users")
      .select("user_id, role")
      .eq("user_id", thread.bound_by_user_id)
      .maybeSingle<{ user_id: string; role: string | null }>();
    if (mErr || !member || member.role !== "owner") return null;
    return member.user_id;
  } catch {
    return null;
  }
}

export async function tenantIsFree(tenant_id: string): Promise<boolean | null> {
  try {
    const { resolveTenantTier, loadTierGateConfig } = await import("./entitlement");
    const tier = await resolveTenantTier(tenant_id, await loadTierGateConfig());
    return tierRank(tier) < tierRank("starter");
  } catch {
    return null;
  }
}

export type ApplyConfirmResult =
  | { ok: true; agent_id: string; name: string; action: ConfirmAction; text: string }
  | { ok: false; text: string };

export type ApplyConfirmSeams = {
  isFree: (tenant_id: string) => Promise<boolean | null>;
  reservedNames: () => Promise<string[]>;
  rpc: (
    tenant_id: string,
    name: "create_custom_agent" | "update_custom_agent",
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string | null; code?: string | null } | null }>;
};

export const defaultApplySeams: ApplyConfirmSeams = {
  isFree: tenantIsFree,
  reservedNames: async () => {
    const { listGlobalAgentSlugs } = await import("./registry");
    return customAgentReservedNames(listGlobalAgentSlugs());
  },
  rpc: async (tenant_id, name, args) => {
    const r = await tenantRpc(asTenantId(tenant_id), name, args);
    return { data: r.data, error: r.error };
  },
};

function rpcErrorText(error: { message?: string | null }): string {
  const msg = error.message ?? "";
  if (msg.includes("plan_upgrade_required")) return planRefusalText();
  if (msg.includes("custom_agent_already_created") || msg.includes("custom_agents_tenant_origin_run")) {
    return "This agent was already created.";
  }
  if (msg.includes("custom_agent_name_reserved")) return NAME_RESERVED_REPLY;
  if (msg.includes("custom_agent_name_taken") || msg.includes("custom_agents_tenant_name_live")) {
    return NAME_TAKEN_REPLY;
  }
  if (msg.includes("custom_agent_not_found")) return "Agent not found.";
  return CONFIRM_FAILED_REPLY;
}

export async function applyCustomAgentConfirm(
  token: ConfirmTokenRow,
  creator: { created_by: string | null; slack_user_id: string | null },
  seams: ApplyConfirmSeams = defaultApplySeams,
  now: Date = new Date(),
): Promise<ApplyConfirmResult> {
  const free = await seams.isFree(token.tenant_id);
  if (free === null) return { ok: false, text: CONFIRM_FAILED_REPLY };
  if (free) return { ok: false, text: planRefusalText() };

  const parsed = customAgentDraftSchema.safeParse(token.draft);
  if (!parsed.success) return { ok: false, text: CONFIRM_INVALID_REPLY };
  const draft = parsed.data;
  const reserved = await seams.reservedNames();
  if (!customAgentNameNorm(draft.name)) return { ok: false, text: CONFIRM_INVALID_REPLY };
  if (isReservedCustomAgentName(draft.name, reserved)) {
    return { ok: false, text: NAME_RESERVED_REPLY };
  }
  if (instructionsRejection(draft.instructions)) return { ok: false, text: CONFIRM_INVALID_REPLY };
  const resolved = resolveCustomTriggers(draft.triggers as CustomTrigger[], "UTC", now);
  if (!resolved.ok) return { ok: false, text: CONFIRM_INVALID_REPLY };

  if (token.action === "create") {
    const { data, error } = await seams.rpc(token.tenant_id, "create_custom_agent", {
      p_name: draft.name,
      p_role: draft.role ?? "",
      p_instructions: draft.instructions,
      p_tools: draft.tools ?? [],
      p_default_deliver: draft.deliver ?? null,
      p_status: "active",
      p_triggers: resolved.triggers,
      p_reserved_names: reserved,
      p_created_by: creator.created_by,
      p_slack_user_id: creator.slack_user_id,
      p_origin_run_id: token.origin_run_id,
    });
    if (error || !data) return { ok: false, text: error ? rpcErrorText(error) : CONFIRM_FAILED_REPLY };
    const row = data as { id: string; name: string };
    return { ok: true, agent_id: row.id, name: row.name, action: "create", text: confirmSuccessText("create", row.id) };
  }

  if (!token.agent_id) return { ok: false, text: CONFIRM_INVALID_REPLY };
  const { data, error } = await seams.rpc(token.tenant_id, "update_custom_agent", {
    p_agent_id: token.agent_id,
    p_name: draft.name,
    p_role: draft.role ?? "",
    p_instructions: draft.instructions,
    p_tools: draft.tools ?? [],
    p_default_deliver: null,
    p_triggers: resolved.triggers,
    p_reserved_names: reserved,
    p_clear_deliver: false,
  });
  if (error || !data) return { ok: false, text: error ? rpcErrorText(error) : CONFIRM_FAILED_REPLY };
  const row = data as { id: string; name: string };
  return {
    ok: true,
    agent_id: row.id,
    name: row.name,
    action: "update",
    text: confirmSuccessText("update", row.id),
  };
}

function triggerLine(t: CustomTrigger): string {
  if (t.kind === "schedule") return `When it runs: ${scheduleLabel(t.cron, t.tz)}`;
  return `Checks every ${t.interval_minutes} minutes: ${t.condition}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function draftSummaryText(draft: CustomAgentDraft, action: ConfirmAction, max = 700): string {
  const head = action === "create" ? `New agent: ${draft.name}` : `Change to agent: ${draft.name}`;
  const lines = [head];
  if (draft.role) lines.push(draft.role);
  const triggers = draft.triggers.length > 0 ? draft.triggers.map(triggerLine) : ["When you ask for it by name"];
  lines.push(...triggers);
  lines.push(`Instructions: ${clip(draft.instructions.replace(/\s+/g, " ").trim(), max)}`);
  lines.push(CUSTOM_AGENT_REAL_CHANGES_WARNING);
  return lines.join("\n");
}

export function buildSlackConfirmBlocks(
  draft: CustomAgentDraft,
  action: ConfirmAction,
  code: string,
  hash: string,
): Array<Record<string, unknown>> {
  const head = action === "create" ? `*New agent: ${draft.name}*` : `*Change to agent: ${draft.name}*`;
  const triggers = draft.triggers.length > 0 ? draft.triggers.map(triggerLine) : ["When you ask for it by name"];
  const body = [head, draft.role ? draft.role : null, ...triggers.map((l) => `• ${l}`)].filter(Boolean).join("\n");
  return [
    { type: "section", text: { type: "mrkdwn", text: clip(body, 2900) } },
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(`*Instructions*\n${draft.instructions}`, 2900) },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: CUSTOM_AGENT_REAL_CHANGES_WARNING }] },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: SLACK_ACTION_CUSTOM_AGENT_CONFIRM,
          text: { type: "plain_text", text: "Confirm" },
          value: confirmButtonValue(code, hash),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            action === "create"
              ? "Nothing is created until you click Confirm. The button works once and expires in 30 minutes."
              : "Nothing changes until you click Confirm. The button works once and expires in 30 minutes.",
        },
      ],
    },
  ];
}

export function whatsappConfirmLine(action: ConfirmAction, code: string): string {
  return action === "create" ? `Reply CONFIRM ${code} to create it.` : `Reply CONFIRM ${code} to apply the change.`;
}

export function buildWhatsAppConfirmMessage(
  draft: CustomAgentDraft,
  action: ConfirmAction,
  code: string,
  hash: string,
): Record<string, unknown> {
  const line = `${whatsappConfirmLine(action, code)} It expires in 30 minutes.`;
  const summary = draftSummaryText(draft, action, 400);
  const body = `${clip(summary, 1024 - line.length - 2)}\n\n${line}`;
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: `${WA_CONFIRM_BUTTON_PREFIX}${confirmButtonValue(code, hash)}`, title: "Confirm" } },
        ],
      },
    },
  };
}

export function buildWhatsAppConfirmText(draft: CustomAgentDraft, action: ConfirmAction, code: string): string {
  return `${draftSummaryText(draft, action, 1500)}\n\n${whatsappConfirmLine(action, code)} It expires in 30 minutes.`;
}

export function parseWhatsAppConfirmButton(msg: unknown): { code: string; hash: string } | null {
  const m = msg as { type?: unknown; interactive?: { type?: unknown; button_reply?: { id?: unknown } } } | null;
  if (!m || m.type !== "interactive" || m.interactive?.type !== "button_reply") return null;
  const id = String(m.interactive?.button_reply?.id ?? "");
  if (!id.startsWith(WA_CONFIRM_BUTTON_PREFIX)) return null;
  return parseConfirmButtonValue(id.slice(WA_CONFIRM_BUTTON_PREFIX.length));
}
