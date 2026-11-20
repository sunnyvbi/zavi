
import { getBoolSetting, getBoolSettingStrictResolved } from "@/services/settings";
import { webBaseUrl, workspaceUrl } from "@/services/web-base";
import {
  asTenantId,
  onboardingEmailRpc,
  staffCrossTenantClient,
  tenantClient,
} from "@/services/tenant-client";
import {
  resolveSequenceRecipient,
  sendOnboardingSequenceEmail,
  type SequenceRecipient,
} from "@/email/sendAuthEmail";
import { greetingName, type ResultsContent } from "@/email/templates/onboarding-sequence";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { planIncludesChannel } from "@/services/growth/preview-plan";
import { stepByNumber } from "./steps";
import { CHANNELS_FOR_STEP, DIGEST, MIN_GAP_MS, needsFacts, planNext, WELCOME, type PlanDecision, type ResultsStep } from "./plan";
import { claimResultsEmail, releaseResultsEmail } from "@/services/growth/results-email-claim";
import { loadWorkspaceFacts, type WorkspaceFacts } from "./facts";
import { channelResults, digestResults } from "./content";
import { releasePacedChannels } from "@/services/channels/onboarding-pacing";
import { isDefiniteSendRejection } from "./send-errors";
import { publicApiBaseUrl } from "@/services/api-base";

const TABLE = "onboarding_email_sequence";
const DAY_MS = 86_400_000;
export { MIN_GAP_MS };
const SWEEP_BATCH = 200;

export type SequenceRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  unsub_token: string;
  started_at: string;
  last_step: number;
  last_sent_at: string | null;
  next_due_at: string | null;
  status: "active" | "completed" | "unsubscribed" | "stopped";
  sent_steps: number[];
  skipped_steps: number[];
  channel_order: number[] | null;
  wait_since: string | null;
  digest_until: string | null;
};

const ROW_COLUMNS =
  "id, tenant_id, user_id, unsub_token, started_at, last_step, last_sent_at, next_due_at, status, " +
  "sent_steps, skipped_steps, channel_order, wait_since, digest_until";

export type SendOutcome =
  | "sent"
  | "lost_race"
  | "waiting_unverified"
  | "no_address"
  | "over"
  | "waiting"
  | "unconfirmed"
  | "failed";

export async function isSequenceEnabled(): Promise<boolean> {
  return getBoolSetting("onboarding_email_sequence_enabled");
}

export function unsubscribeUrlFor(token: string): string {
  return `${publicApiBaseUrl()}/api/onboarding-emails/unsubscribe?t=${encodeURIComponent(token)}`;
}

export async function enrolOwner(args: {
  tenant_id: string;
  user_id: string;
  welcomeAlreadySent?: boolean;
}): Promise<SequenceRow | null> {
  const cross = staffCrossTenantClient("onboarding emails: one sequence per person, and honour a person-wide opt-out");
  const mine = await cross.from(TABLE).select("id, tenant_id, status").eq("user_id", args.user_id).limit(50);
  if (mine.error) throw new Error(`onboarding emails: person check failed: ${mine.error.message}`);
  const theirs = (mine.data ?? []) as Array<{ tenant_id: string; status: string }>;
  if (theirs.some((r) => r.status === "unsubscribed")) return null;
  if (theirs.some((r) => r.tenant_id !== args.tenant_id && r.status !== "stopped")) return null;

  const t = await cross.from("tenants").select("slug, kind, deleted_at").eq("id", args.tenant_id).maybeSingle();
  if (t.error) throw new Error(`onboarding emails: tenant check failed: ${t.error.message}`);
  const tenant = t.data as { slug?: string | null; kind?: string | null; deleted_at?: string | null } | null;
  if (tenant && notMailable(tenant)) return null;

  const db = tenantClient(asTenantId(args.tenant_id));
  const now = new Date();
  const fresh = args.welcomeAlreadySent
    ? {
        user_id: args.user_id,
        last_step: WELCOME,
        sent_steps: [WELCOME],
        last_sent_at: now.toISOString(),
        next_due_at: new Date(now.getTime() + DAY_MS).toISOString(),
      }
    : { user_id: args.user_id };
  const ins = await db.from(TABLE).upsert(fresh, { onConflict: "tenant_id,user_id", ignoreDuplicates: true });
  if (ins.error && (ins.error as { code?: string }).code === "23505") return null;
  if (ins.error) throw new Error(`onboarding emails: enrol failed: ${ins.error.message}`);

  const { data, error } = await db
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq("user_id", args.user_id)
    .maybeSingle<SequenceRow>();
  if (error) throw new Error(`onboarding emails: enrol read failed: ${error.message}`);
  return data ?? null;
}

export type StepClaim = {
  step: number;
  skip: number[];
  nextDue: Date | null;
  channelOrder: number[] | null;
};

type Deps = {
  resolveRecipient: (user_id: string) => Promise<SequenceRecipient | null>;
  send: typeof sendOnboardingSequenceEmail;
  claimStep: (row: SequenceRow, claim: StepClaim) => Promise<boolean>;
  releaseStep: (row: SequenceRow, claim: StepClaim, error: string) => Promise<void>;
  defer: (row: SequenceRow, until: Date, stampWait: boolean, now: Date) => Promise<void>;
  complete: (row: SequenceRow, skip: number[], now: Date) => Promise<void>;
  stop: (row: SequenceRow) => Promise<void>;
  facts: (row: SequenceRow, now: Date) => Promise<WorkspaceFacts>;
  planIncludes: (tenant_id: string, slug: string) => Promise<boolean>;
  links: () => { workspaceUrl: string; imageBaseUrl: string };
  stillEnabled: (tenant_id: string) => Promise<boolean>;
  claimResultsEmail: (tenant_id: string) => Promise<boolean>;
  releaseResultsEmail: (tenant_id: string) => Promise<void>;
  releaseHeld?: (tenant_id: string, channels: readonly string[]) => Promise<number>;
};

const DIGEST_CLAIMER = "system:onboarding-digest";

const realDeps: Deps = {
  resolveRecipient: (user_id) => resolveSequenceRecipient(user_id),
  send: (args) => sendOnboardingSequenceEmail(args),
  async claimStep(row, c) {
    const { data, error } = await onboardingEmailRpc("onboarding_email_claim_step", {
      p_id: row.id,
      p_step: c.step,
      p_also: [],
      p_skip: c.skip,
      p_next_due: c.nextDue ? c.nextDue.toISOString() : null,
      p_channel_order: c.channelOrder,
    });
    if (error) throw new Error(`onboarding emails: claim failed: ${error.message}`);
    return data === true;
  },
  async releaseStep(row, c, error) {
    const { error: e } = await onboardingEmailRpc("onboarding_email_release_step", {
      p_id: row.id,
      p_step: c.step,
      p_also: [],
      p_skip: c.skip,
      p_prev_step: row.last_step,
      p_prev_sent_at: row.last_sent_at,
      p_error: error,
    });
    if (e) console.warn(`[onboarding-emails] release failed for ${row.id}: ${e.message}`);
  },
  async defer(row, until, stampWait, now) {
    const { error } = await tenantClient(asTenantId(row.tenant_id))
      .from(TABLE)
      .update({
        next_due_at: until.toISOString(),
        wait_since: stampWait ? (row.wait_since ?? now.toISOString()) : row.wait_since,
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "active")
      .lte("next_due_at", now.toISOString());
    if (error) console.warn(`[onboarding-emails] defer failed for ${row.id}: ${error.message}`);
  },
  async complete(row, skip, now) {
    const { error } = await tenantClient(asTenantId(row.tenant_id))
      .from(TABLE)
      .update({
        status: "completed",
        next_due_at: null,
        skipped_steps: [...new Set([...(row.skipped_steps ?? []), ...skip])].sort((a, b) => a - b),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "active")
      .lte("next_due_at", now.toISOString());
    if (error) console.warn(`[onboarding-emails] complete failed for ${row.id}: ${error.message}`);
  },
  async stop(row) {
    const { error } = await staffCrossTenantClient("onboarding emails: stop a sequence with nobody to send to")
      .from(TABLE)
      .update({ status: "stopped", next_due_at: null, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "active");
    if (error) console.warn(`[onboarding-emails] stop failed for ${row.id}: ${error.message}`);
  },
  facts: (row, now) => loadWorkspaceFacts(row.tenant_id, row.started_at, now),
  planIncludes: (tenant_id, slug) => planIncludesChannel(tenant_id, slug),
  links: () => ({ workspaceUrl: workspaceUrl(), imageBaseUrl: webBaseUrl() }),
  stillEnabled: (tenant_id) => getBoolSettingStrictResolved("onboarding_email_sequence_enabled", tenant_id),
  claimResultsEmail: (tenant_id) => claimResultsEmail(tenant_id, DIGEST_CLAIMER),
  releaseResultsEmail: (tenant_id) => releaseResultsEmail(tenant_id, DIGEST_CLAIMER),
  releaseHeld: (tenant_id, channels) => releasePacedChannels(tenant_id, channels),
};

function normalised(row: SequenceRow): SequenceRow {
  return {
    ...row,
    sent_steps: Array.isArray(row.sent_steps) ? row.sent_steps : [],
    skipped_steps: Array.isArray(row.skipped_steps) ? row.skipped_steps : [],
    channel_order: Array.isArray(row.channel_order) ? row.channel_order : null,
    wait_since: row.wait_since ?? null,
    digest_until: row.digest_until ?? null,
  };
}

async function resultsFor(
  row: SequenceRow,
  step: number,
  variant: "intro" | "results" | "digest",
  facts: WorkspaceFacts | null,
  workspaceUrl: string,
  deps: Deps,
): Promise<ResultsContent | undefined> {
  if (!facts || variant === "intro") return undefined;
  if (variant === "digest") return digestResults({ facts, workspaceUrl }) ?? undefined;
  const slugs = CHANNELS_FOR_STEP[step as ResultsStep] ?? [];
  if (deps.releaseHeld) await deps.releaseHeld(row.tenant_id, slugs);
  const includes = new Map<string, boolean>();
  for (const slug of slugs) includes.set(slug, await deps.planIncludes(row.tenant_id, slug).catch(() => false));
  return channelResults({ step: step as ResultsStep, facts, workspaceUrl, planLacks: (s) => includes.get(s) !== true }) ?? undefined;
}

export async function sendNextStep(
  input: SequenceRow,
  now: Date = new Date(),
  deps: Deps = realDeps,
): Promise<SendOutcome> {
  const row = normalised(input);
  const facts = needsFacts(row, now) ? await deps.facts(row, now) : null;
  let decision: PlanDecision = planNext(row, facts?.plan ?? null, now);
  const settle = async (d: Exclude<PlanDecision, { kind: "send" }>): Promise<SendOutcome> => {
    if (d.kind === "wait") {
      await deps.defer(row, d.until, d.stampWait, now);
      return "waiting";
    }
    await deps.complete(row, d.skip, now);
    return "over";
  };
  if (decision.kind !== "send") return settle(decision);

  const who = await deps.resolveRecipient(row.user_id);
  if (!who) {
    await deps.stop(row);
    return "no_address";
  }
  if (!who.verified) return "waiting_unverified";

  let heldClaim = false;
  if (decision.step === DIGEST) {
    if (await deps.claimResultsEmail(row.tenant_id)) {
      heldClaim = true;
    } else {
      const plan = facts?.plan ?? { openCards: new Map(), used: new Set<string>(), inFlight: new Set<string>(), paidRerunsInFlight: false, upgradeEmailSent: true };
      decision = planNext(row, { ...plan, upgradeEmailSent: true }, now);
      if (decision.kind !== "send") return settle(decision);
    }
  }
  const step = stepByNumber(decision.step);
  if (!step) {
    if (heldClaim) await deps.releaseResultsEmail(row.tenant_id);
    return "over";
  }

  const links = deps.links();
  let results: Awaited<ReturnType<typeof resultsFor>>;
  try {
    results = await resultsFor(row, decision.step, decision.variant, facts, links.workspaceUrl, deps);
  } catch (e) {
    if (heldClaim) await deps.releaseResultsEmail(row.tenant_id);
    throw e;
  }
  const claim: StepClaim = {
    step: decision.step,
    skip: decision.skip.filter((s) => !row.skipped_steps.includes(s)),
    nextDue: decision.nextDue,
    channelOrder: row.channel_order ? null : decision.channelOrder,
  };
  let stepClaimed: boolean;
  try {
    stepClaimed = await deps.claimStep(row, claim);
  } catch (e) {
    if (heldClaim) await deps.releaseResultsEmail(row.tenant_id);
    throw e;
  }
  if (!stepClaimed) {
    if (heldClaim) await deps.releaseResultsEmail(row.tenant_id);
    return "lost_race";
  }

  try {
    await deps.send({
      to: who.email,
      step,
      firstName: greetingName(who.name),
      workspaceUrl: links.workspaceUrl,
      imageBaseUrl: links.imageBaseUrl,
      unsubscribeUrl: unsubscribeUrlFor(row.unsub_token),
      ...(results ? { results } : {}),
    });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (isDefiniteSendRejection(e)) {
      await deps.releaseStep(row, claim, message);
      if (heldClaim) await deps.releaseResultsEmail(row.tenant_id);
      return "failed";
    }
    console.warn(`[onboarding-emails] email ${decision.step} for ${row.id} unconfirmed, not retried: ${message}`);
    return "unconfirmed";
  }
  return "sent";
}

export async function enrolAndSendFirst(args: { tenant_id: string; user_id: string }): Promise<boolean> {
  let row: SequenceRow | null;
  try {
    if (!(await isSequenceEnabled())) return await hasOptedOut(args.user_id);
    row = await enrolOwner(args);
  } catch (e) {
    console.warn(`[onboarding-emails] enrol failed for ${args.tenant_id}: ${(e as Error).message}`);
    return false;
  }
  if (!row) return true;
  if (row.last_step === 0 && !(row.sent_steps ?? []).includes(WELCOME)) {
    try {
      const outcome = await sendNextStep(row);
      if (outcome === "failed" || outcome === "waiting_unverified") {
        console.warn(`[onboarding-emails] email 1 not sent for ${args.tenant_id}: ${outcome}; the sweep will retry`);
      }
    } catch (e) {
      console.warn(`[onboarding-emails] email 1 errored for ${args.tenant_id}: ${(e as Error).message}; the sweep will retry`);
    }
  }
  return true;
}

async function hasOptedOut(user_id: string): Promise<boolean> {
  const { data, error } = await staffCrossTenantClient("onboarding emails: honour a person-wide opt-out while the sequence is off")
    .from(TABLE)
    .select("id")
    .eq("user_id", user_id)
    .eq("status", "unsubscribed")
    .limit(1);
  if (error) throw new Error(`onboarding emails: opt-out check failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function enrolFromDayOne(args: { tenant_id: string; user_id: string }): Promise<boolean> {
  try {
    if (!(await isSequenceEnabled())) return false;
    return (await enrolOwner({ ...args, welcomeAlreadySent: true })) !== null;
  } catch (e) {
    console.warn(`[onboarding-emails] enrol failed for ${args.tenant_id}: ${(e as Error).message}`);
    return false;
  }
}

export type SweepResult =
  | { skipped: "disabled" }
  | { examined: number; sent: number; failed: number; stopped: number; other: number };

export async function sweepDueSequences(now: Date = new Date(), deps: Deps = realDeps): Promise<SweepResult> {
  if (!(await isSequenceEnabled())) return { skipped: "disabled" };

  const cross = staffCrossTenantClient("onboarding emails: sweep every workspace's due emails");
  const { data, error } = await cross
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq("status", "active")
    .lte("next_due_at", now.toISOString())
    .order("next_due_at", { ascending: true })
    .limit(SWEEP_BATCH);
  if (error) throw new Error(`onboarding emails: due read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as SequenceRow[];

  const dead = await deadTenants(rows.map((r) => r.tenant_id));
  const out = { examined: rows.length, sent: 0, failed: 0, stopped: 0, other: 0 };
  for (const row of rows) {
    if (dead.has(row.tenant_id)) {
      await deps.stop(row);
      out.stopped++;
      continue;
    }
    let on = false;
    try {
      on = await deps.stillEnabled(row.tenant_id);
    } catch (e) {
      console.warn(`[onboarding-emails] switch read failed, stopping the sweep: ${(e as Error).message}`);
    }
    if (!on) break;
    try {
      const r = await sendNextStep(row, now, deps);
      if (r === "sent") out.sent++;
      else if (r === "failed") out.failed++;
      else if (r === "no_address") out.stopped++;
      else out.other++;
    } catch (e) {
      out.failed++;
      console.warn(`[onboarding-emails] ${row.id} errored: ${(e as Error).message}`);
    }
  }
  return out;
}

function notMailable(t: { slug?: string | null; kind?: string | null; deleted_at?: string | null }): boolean {
  return t.kind === "test" || !!t.deleted_at || (!!t.slug && DOGFOOD_SLUGS.has(t.slug));
}

async function deadTenants(tenantIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(tenantIds)];
  const dead = new Set<string>();
  const cross = staffCrossTenantClient("onboarding emails: skip test and deleted workspaces");
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await cross.from("tenants").select("id, slug, kind, deleted_at").in("id", chunk);
    if (error) throw new Error(`onboarding emails: tenant read failed: ${error.message}`);
    const live = new Set<string>();
    for (const t of (data ?? []) as Array<{ id: string; slug: string | null; kind: string | null; deleted_at: string | null }>) {
      if (!notMailable(t)) live.add(t.id);
    }
    for (const id of chunk) if (!live.has(id)) dead.add(id);
  }
  return dead;
}

export async function unsubscribeByToken(token: string, source: "link" | "one_click"): Promise<boolean> {
  const { data, error } = await onboardingEmailRpc("onboarding_email_unsubscribe", {
    p_token: token,
    p_source: source,
  });
  if (error) throw new Error(`onboarding emails: unsubscribe failed: ${error.message}`);
  return data === true;
}
