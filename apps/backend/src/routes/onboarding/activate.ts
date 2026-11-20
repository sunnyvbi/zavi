
import { metaShapeCandidates, type ShapeCandidate } from "@/services/onboarding/shape-candidates";
import { sendGoalAttention } from "@/services/growth/goal-attention";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { track, setProfile } from "@/services/analytics/mixpanel";
import { seedTenantBootstrap } from "@/services/tenants/bootstrap";
import { auditTenantKind } from "@/services/tenants/classify-test-tenant";
import { notifyNewTenant } from "@/services/tenants/new-tenant-alert";
import { persistSignupAttribution } from "@/services/tenants/signup-attribution";
import { attributeTenant } from "@/services/affiliates/attribution";
import { ensureEnrichmentTask } from "@/services/staff/admin-tasks/ensure-enrichment-task";
import { requireClosedBetaGrant } from "@/services/auth/closedBetaGate";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";
import { setSessionTenant } from "@/services/tenants/session-tenant";
import { checkSelfServeTenantCap } from "@/services/tenants/tenant-create-guard";
import { setTenantSetting, getBoolSetting, getSetting } from "@/services/settings";
import { validateCustomBrands, MAX_CUSTOM_BRANDS } from "@/services/competitor-intel/brands";
import {
  getCompanyFacts,
  joinCompetitors,
  projectCompanyFactValue,
  COMPANY_STORY_MAX,
  setCompanyDomain,
  setCompanyFact,
} from "@/services/company/facts";
import { firstSentence } from "@/services/company/suggestions";
import { autoSetCompanyCountryInBackground } from "@/services/company/country-inference";
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
} from "@/services/onboarding/enrichment/sanitize";
import { detectGoalJunk } from "@/services/autopilot/goal-metric-vocab";
import { COMPANY_SHAPES } from "@/services/onboarding/enrichment/classify-shape-stage";
import { isPlatformHost } from "@/services/onboarding/enrichment/domain-match";
import { setGoalMeasurementMode } from "@/services/autopilot/goal-measurement";
import { writeAutopilotGoal } from "@/services/growth/goal-write";
import { sendWelcomeEmail } from "@/email/sendAuthEmail";
import { enrolAndSendFirst } from "@/services/onboarding-emails/sequence";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import {
  NEW_BRAIN_SLUGS,
  scoreSlot,
  slugsToSeed,
  thinPlaceholderBody,
  type SlotStatus,
} from "@/services/memory/brain-slots";
import { logOnboardingStep } from "./step-events";
import { workspaceUrl } from "@/services/web-base";
import { reserveWorkspaceSlot, WORKSPACE_LIMIT_MESSAGE } from "@/services/onboarding/workspace-create-limit";
import { PUBLIC_ID_RE } from "@/services/start-card/store";
import { activationHost, startBackgroundMemory } from "@/services/onboarding/background-memory";
import { isValidTimeZone } from "@/services/analytics/metric-time";
import { canonicalTz } from "@/services/agents/custom-agents";
import { buildRequestKeyFrom } from "@/services/agents/build-request-key";
import { claimStart, recordStartClaim, releaseStartClaim, waitForClaimedTenant } from "@/services/onboarding/start-claims";

const CANONICAL_SLUGS = new Set([
  "company",
  "ops",
  "policies",
  "disputes",
  "support",
]);

const BUILD_APP_INTENT_DRAFT_KEY = "_build_app_intent";
const VALID_BUILD_APP_INTENTS = new Set<string>(["fresh", "existing"]);

const COMPANY_SCALE_SEGMENT_DRAFT_KEY = "_company_scale_segment";
const VALID_COMPANY_SCALE_SEGMENTS = new Set<string>([
  "pre_revenue",
  "early",
  "scaling",
  "mature",
]);

async function readBuildAppIntentFromDraft(
  user_id: string,
): Promise<"fresh" | "existing" | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("onboarding_draft")
    .select("wizard")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return null;
  const wizardBlob = (data.wizard ?? {}) as Record<string, unknown>;
  const raw = wizardBlob[BUILD_APP_INTENT_DRAFT_KEY];
  if (typeof raw !== "string") return null;
  if (!VALID_BUILD_APP_INTENTS.has(raw)) return null;
  return raw as "fresh" | "existing";
}

type CompanyScaleSegment = "pre_revenue" | "early" | "scaling" | "mature";

async function readCompanyScaleSegmentFromDraft(
  user_id: string,
): Promise<CompanyScaleSegment | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("onboarding_draft")
    .select("wizard")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return null;
  const wizardBlob = (data.wizard ?? {}) as Record<string, unknown>;
  const raw = wizardBlob[COMPANY_SCALE_SEGMENT_DRAFT_KEY];
  if (typeof raw !== "string") return null;
  if (!VALID_COMPANY_SCALE_SEGMENTS.has(raw)) return null;
  return raw as CompanyScaleSegment;
}

const AUTOPILOT_GOAL_DRAFT_KEY = "_autopilot_goal";

type DraftAutopilotGoal = {
  objective: string;
  target_metric: string;
  target_value: number;
  due_date?: string;
};

async function readAutopilotGoalFromDraft(
  user_id: string,
): Promise<DraftAutopilotGoal | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("onboarding_draft")
    .select("wizard")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return null;
  const wizardBlob = (data.wizard ?? {}) as Record<string, unknown>;
  const raw = wizardBlob[AUTOPILOT_GOAL_DRAFT_KEY];
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;

  const objective = typeof g.objective === "string" ? g.objective.trim() : "";
  if (objective.length < 4 || objective.length > 500) return null;

  const target_metric =
    typeof g.target_metric === "string" ? g.target_metric.trim() : "";
  if (target_metric.length < 1 || target_metric.length > 120) return null;

  if (typeof g.target_value !== "number" || !Number.isFinite(g.target_value) || g.target_value <= 0) {
    return null;
  }
  const target_value = g.target_value;

  let due_date: string | undefined;
  if (g.due_date !== undefined && g.due_date !== null && g.due_date !== "") {
    if (typeof g.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(g.due_date)) {
      return null;
    }
    if (!Number.isFinite(Date.parse(g.due_date))) return null;
    due_date = g.due_date;
  }

  return { objective, target_metric, target_value, ...(due_date ? { due_date } : {}) };
}

export async function persistDraftGoal(
  tenant_id: string,
  user_id: string,
): Promise<void> {
  try {
    const goal = await readAutopilotGoalFromDraft(user_id);
    if (goal === null) return;
    const junkReason = detectGoalJunk({
      objective: goal.objective,
      target_metric: goal.target_metric,
      target_value: goal.target_value,
    });
    if (junkReason) {
      console.warn(
        `[onboarding/activate] dropping junk draft goal for ${tenant_id}: ${junkReason}`,
      );
      return;
    }
    const cleanObjective = xmlEscapeContent(sanitizeFetchedContent(goal.objective));
    const cleanMetric = xmlEscapeContent(sanitizeFetchedContent(goal.target_metric));
    const founder = { source: "founder" as const, user_id };
    const created = await writeAutopilotGoal(tenant_id, {
      op: "insert",
      values: {
        objective: cleanObjective,
        target_metric: cleanMetric,
        target_value: goal.target_value,
        baseline_value: null,
        current_value: null,
        due_date: goal.due_date ?? null,
        priority: 50,
        source: "founder",
      },
      actor: founder,
    });
    if (created.status !== "written") {
      console.warn(
        `[onboarding/activate] goal write failed for ${tenant_id}: ${created.status === "error" ? created.error : "not written"}`,
      );
    } else {
      const goalId = created.id;
      await setGoalMeasurementMode(tenant_id, goalId, goal.target_metric, founder);
      await sendGoalAttention({ tenant_id, reason: "goal_set", goal_id: goalId });
    }
  } catch (e) {
    console.warn(
      `[onboarding/activate] persistDraftGoal failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

export type { ShapeCandidate };

export function resolveCompanyShape(
  candidates: readonly ShapeCandidate[],
): { shape: string; kind: "operator" | "inferred" } | null {
  const valid = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.toLowerCase().trim() : "";
    return (COMPANY_SHAPES as readonly string[]).includes(s) ? s : null;
  };
  for (const c of candidates) {
    if (c.kind !== "operator") continue;
    const s = valid(c.shape);
    if (s && s !== "other") return { shape: s, kind: "operator" };
  }
  for (const c of candidates) {
    if (c.kind !== "inferred") continue;
    if (c.confidence !== "high") continue;
    const s = valid(c.shape);
    if (s && s !== "other") return { shape: s, kind: "inferred" };
  }
  for (const c of candidates) {
    if (c.kind !== "operator") continue;
    const s = valid(c.shape);
    if (s) return { shape: s, kind: "operator" };
  }
  return null;
}

export async function persistCompanyShapeFrom(
  tenant_id: string,
  candidates: readonly ShapeCandidate[],
): Promise<string | null> {
  try {
    const resolved = resolveCompanyShape(candidates);
    if (!resolved) return null;
    const { error } = await serviceClient()
      .from("tenants")
      .update({ company_shape: resolved.shape, company_shape_source: resolved.kind === "operator" ? "founder" : "inferred" })
      .eq("id", tenant_id);
    if (error) {
      console.warn(
        `[onboarding] persistCompanyShapeFrom update failed for ${tenant_id}: ${error.message}`,
      );
      return null;
    }
    return resolved.shape;
  } catch (e) {
    console.warn(
      `[onboarding] persistCompanyShapeFrom failed for ${tenant_id}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function persistCompanyShape(
  tenant_id: string,
  user_id: string,
  onboardingMeta?: unknown,
): Promise<void> {
  const candidates: ShapeCandidate[] = metaShapeCandidates(onboardingMeta);

  try {
    const { data } = await serviceClient()
      .from("onboarding_draft")
      .select("wizard")
      .eq("user_id", user_id)
      .maybeSingle();
    const wizardBlob = (data?.wizard ?? {}) as Record<string, unknown>;
    if (wizardBlob.marketplaceShape !== undefined) {
      candidates.push({ kind: "operator", shape: wizardBlob.marketplaceShape });
    }
    const enrichment = (wizardBlob._enrichment ?? {}) as Record<string, unknown>;
    if (enrichment.inferredShape !== undefined) {
      candidates.push({
        kind: "inferred",
        shape: enrichment.inferredShape,
        confidence: enrichment.shapeConfidence,
      });
    }
  } catch (e) {
    console.warn(
      `[onboarding/activate] draft read for shape failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  await persistCompanyShapeFrom(tenant_id, candidates);
}

const ENRICHMENT_DRAFT_KEY = "_enrichment";
const CUSTOM_BRANDS_SETTING = "competitor_intel_custom_brands";

const WEBSITE_DRAFT_KEY = "website";

const ENRICHMENT_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

function isPlatformUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const s = raw.trim();
    return isPlatformHost(new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname);
  } catch {
    return false;
  }
}

function toCanonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    if (isPlatformHost(u.hostname)) return null;
    return `https://${u.hostname}`;
  } catch {
    return null;
  }
}

const WHAT_WE_SELL_MAX = 500;

export async function writeTypedFactsFromWizard(
  tenant_id: string,
  user_id: string,
  wizardBlob: Record<string, unknown>,
  opts: { skipWhatWeSell?: boolean } = {},
): Promise<void> {
  const ref = `onboarding wizard — typed by the operator (user ${user_id})`;
  const typed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const orgName = typed(wizardBlob.orgName);
  if (orgName) {
    const { ok, error } = await setCompanyFact(tenant_id, "company_name", orgName, ref);
    if (!ok) {
      console.warn(`[onboarding/activate] company_name not written for ${tenant_id}: ${error}`);
    }
  }

  const about = typed(wizardBlob.freeText)
    .replace(/\n\s*\n\s*Founder-confirmed competitors[^\n]*/i, "")
    .trim();
  if (about) {
    if (!opts.skipWhatWeSell) {
      const oneLine =
        about.length <= WHAT_WE_SELL_MAX ? about : (firstSentence(about) ?? about.slice(0, WHAT_WE_SELL_MAX));
      const { ok, error } = await setCompanyFact(tenant_id, "what_we_sell", oneLine, ref);
      if (!ok) {
        console.warn(`[onboarding/activate] what_we_sell not written for ${tenant_id}: ${error}`);
      }
    }

    const story = about.length <= COMPANY_STORY_MAX ? about : about.slice(0, COMPANY_STORY_MAX);
    const storyWrite = await setCompanyFact(tenant_id, "company_story", story, ref);
    if (!storyWrite.ok) {
      console.warn(
        `[onboarding/activate] company_story not written for ${tenant_id}: ${storyWrite.error}`,
      );
    }
  }
}

async function persistCompanyFacts(
  tenant_id: string,
  user_id: string,
  onboardingMeta?: unknown,
): Promise<void> {
  try {
    const sb = serviceClient();

    const { data: draft } = await sb
      .from("onboarding_draft")
      .select("wizard")
      .eq("user_id", user_id)
      .maybeSingle();
    const meta = (onboardingMeta ?? {}) as Record<string, unknown>;
    const metaWizard = (meta.wizard ?? {}) as Record<string, unknown>;
    const wizardBlob = {
      ...((draft?.wizard ?? {}) as Record<string, unknown>),
      ...metaWizard,
    } as Record<string, unknown>;

    let origin = toCanonicalOrigin(wizardBlob[WEBSITE_DRAFT_KEY]);
    let source: "human_confirmed" | "onboarding_enrichment" = "human_confirmed";
    let sourceRef = "onboarding wizard — typed by the operator";

    const typedPlatform = isPlatformUrl(wizardBlob[WEBSITE_DRAFT_KEY]);

    if (!origin && !typedPlatform) {
      const enrichment = wizardBlob[ENRICHMENT_DRAFT_KEY];
      const pages =
        enrichment && typeof enrichment === "object"
          ? (enrichment as Record<string, unknown>).domain_pages
          : null;
      if (Array.isArray(pages)) {
        for (const p of pages) {
          const url = p && typeof p === "object" ? (p as Record<string, unknown>).url : null;
          origin = toCanonicalOrigin(url);
          if (origin) {
            source = "onboarding_enrichment";
            sourceRef = "resolved from the customer's website at onboarding";
            break;
          }
        }
      }
    }

    if (!origin && !typedPlatform) {
      const sessionStart = new Date(Date.now() - ENRICHMENT_SESSION_WINDOW_MS).toISOString();
      const { data: audit } = await sb
        .from("enrichment_audit")
        .select("resolved_domain")
        .eq("user_id", user_id)
        .eq("mode", "full")
        .gte("created_at", sessionStart)
        .not("resolved_domain", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ resolved_domain: string | null }>();
      origin = toCanonicalOrigin(audit?.resolved_domain);
      if (origin) {
        source = "onboarding_enrichment";
        sourceRef = "resolved from the customer's website at onboarding";
      }
    }

    await writeTypedFactsFromWizard(tenant_id, user_id, wizardBlob);

    if (!origin) return;

    const { ok: domOk, error: domErr } = await setCompanyDomain(
      tenant_id,
      origin,
      source,
      sourceRef,
    );
    if (!domOk) {
      console.warn(
        `[onboarding/activate] persistCompanyFacts company domain failed for ${tenant_id}: ${domErr}`,
      );
    }
  } catch (e) {
    console.warn(
      `[onboarding/activate] persistCompanyFacts failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

async function readEnrichmentCompetitorNamesFromDraft(
  user_id: string,
): Promise<string[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("onboarding_draft")
    .select("wizard")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return [];
  const wizardBlob = (data.wizard ?? {}) as Record<string, unknown>;
  const enrichment = wizardBlob[ENRICHMENT_DRAFT_KEY];
  if (!enrichment || typeof enrichment !== "object") return [];
  const competitors = (enrichment as Record<string, unknown>).competitors;
  if (!Array.isArray(competitors)) return [];
  return competitors.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const name = (c as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

export async function seedCompetitorBrandsFromEnrichment(
  tenant_id: string,
  user_id: string,
  requestNames?: string[],
): Promise<void> {
  try {
    const names =
      requestNames !== undefined
        ? requestNames
        : await readEnrichmentCompetitorNamesFromDraft(user_id);
    if (names.length === 0) return;
    const record = await getCompanyFacts(tenant_id);
    if (record.competitors.length > 0) return;
    const result = validateCustomBrands(names.slice(0, MAX_CUSTOM_BRANDS));
    if (!result.ok || result.brands.length === 0) return;
    await projectCompanyFactValue(
      tenant_id,
      "competitors",
      joinCompetitors(result.brands),
      "onboarding_enrichment",
      `onboarding enrichment, user ${user_id}`,
    );
  } catch (e) {
    console.warn(
      `[onboarding/activate] seedCompetitorBrandsFromEnrichment failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

const PrimaryAnchorBodySchema = z.object({
  candidate_id: z.string().min(1),
  slug: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  body_markdown: z.string().max(8000),
});

export const TENANT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const Body = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  display_name: z.string().min(1).max(120).optional(),
  rar_weekly: z.number().nonnegative().optional(),
  memory: z.object({
    company: z.string().optional(),
    ops: z.string().optional(),
    policies: z.string().optional(),
    disputes: z.string().optional(),
    support: z.string().optional(),
  }),
  primary_anchors: z.array(PrimaryAnchorBodySchema).max(3).optional(),
  onboarding_meta: z.unknown().optional(),
  competitors: z.array(z.string().max(200)).max(50).optional(),
  additional: z.boolean().optional(),
  attribution: z.unknown().optional(),
  affiliate_click: z.unknown().optional(),
  background_memory: z.boolean().optional(),
  scan_id: z.string().regex(PUBLIC_ID_RE).optional(),
  timezone: z.string().max(64).optional(),
});

const TENANT_SLUG_MAX_LEN = 64;

export function normalizeTenantSlug(raw: string): string {
  return (
    String(raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, TENANT_SLUG_MAX_LEN) || "company"
  );
}

function userSlugSuffix(user_id: string): string {
  return user_id.replace(/-/g, "").slice(0, 8) || randomBytes(4).toString("hex");
}

function slugWithSuffix(base: string, suffix: string): string {
  const maxBaseLen = Math.max(1, TENANT_SLUG_MAX_LEN - suffix.length - 1);
  const trimmedBase = base.slice(0, maxBaseLen).replace(/-+$/g, "") || "company";
  return `${trimmedBase}-${suffix}`;
}

export function activationTenantSlugCandidates(
  preferredSlug: string,
  user_id: string,
): string[] {
  const base = normalizeTenantSlug(preferredSlug);
  const suffix = userSlugSuffix(user_id);
  const candidates = [
    base,
    slugWithSuffix(base, suffix),
    slugWithSuffix(base, `${suffix}-2`),
    slugWithSuffix(base, `${suffix}-3`),
    slugWithSuffix(base, `${suffix}-4`),
    slugWithSuffix(base, `${suffix}-5`),
  ];
  return Array.from(new Set(candidates));
}

function activationClaimKey(header: unknown): string | null {
  const key = buildRequestKeyFrom(header);
  return key && key.length <= 191 ? `activate:${key}` : null;
}

async function userBelongsToTenantSlug(user_id: string, slug: string): Promise<boolean> {
  const sb = serviceClient();
  const { data: tenant, error } = await sb.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`tenant slug lookup failed: ${error.message}`);
  if (!tenant) return false;
  const { data: member, error: memberError } = await sb
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", user_id)
    .eq("role", "owner")
    .eq("tenant_id", (tenant as { id: string }).id)
    .maybeSingle();
  if (memberError) throw new Error(`tenant membership lookup failed: ${memberError.message}`);
  return Boolean(member);
}

export async function resolveActivationTenantSlug({
  preferredSlug,
  user_id,
  additional,
}: {
  preferredSlug: string;
  user_id: string;
  additional: boolean;
}): Promise<string> {
  const sb = serviceClient();
  const candidates = activationTenantSlugCandidates(preferredSlug, user_id);
  const { data: tenants, error: tenantsError } = await sb
    .from("tenants")
    .select("id, slug")
    .in("slug", candidates);
  if (tenantsError) {
    throw new Error(`tenant slug lookup failed: ${tenantsError.message}`);
  }

  const takenBySlug = new Map<string, string>();
  for (const row of (tenants ?? []) as Array<{ id: string; slug: string }>) {
    takenBySlug.set(row.slug, row.id);
  }

  const takenIds = Array.from(takenBySlug.values());
  const ownedTenantIds = new Set<string>();
  if (takenIds.length > 0) {
    const { data: memberships, error: membershipError } = await sb
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", user_id)
      .eq("role", "owner")
      .in("tenant_id", takenIds);
    if (membershipError) {
      throw new Error(`tenant slug membership lookup failed: ${membershipError.message}`);
    }
    for (const row of (memberships ?? []) as Array<{ tenant_id: string }>) {
      ownedTenantIds.add(row.tenant_id);
    }
  }

  for (const candidate of candidates) {
    const tenantId = takenBySlug.get(candidate);
    if (!tenantId) return candidate;
    if (!additional && ownedTenantIds.has(tenantId)) {
      return candidate;
    }
  }

  const base = normalizeTenantSlug(preferredSlug);
  const suffix = userSlugSuffix(user_id);
  for (let i = 0; i < 3; i++) {
    const candidate = slugWithSuffix(base, `${suffix}-${randomBytes(3).toString("hex")}`);
    const { data, error } = await sb
      .from("tenants")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) {
      throw new Error(`tenant slug random lookup failed: ${error.message}`);
    }
    if (!data) return candidate;
  }

  throw new Error("could not find an available tenant slug");
}

function sanitizeBodyMarkdown(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/<(system|assistant|user)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, "");
  s = s.replace(/<\/?\s*(system|assistant|user)\s*\/?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s.slice(0, 1500);
}

function sanitizeTitle(raw: string): string {
  return String(raw ?? "")
    .replace(/[<>&]/g, "")
    .trim()
    .slice(0, 80);
}

function sanitizeSlug(raw: string): string | null {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!s || !/^[a-z0-9-]+$/.test(s)) return null;
  return s;
}

type ValidatedAnchor = {
  candidate_id: string;
  slug: string;
  title: string;
  body_markdown: string;
};

type ValidationOk = { ok: true; anchors: ValidatedAnchor[] };
type ValidationErr = { ok: false; code: string; message: string };
type ValidationResult = ValidationOk | ValidationErr;

async function validatePrimaryAnchors(
  user_id: string,
  submitted: z.infer<typeof PrimaryAnchorBodySchema>[],
): Promise<ValidationResult> {
  if (submitted.length === 0) return { ok: true, anchors: [] };

  const sb = serviceClient();
  const { data: draft, error: draftErr } = await sb
    .from("onboarding_draft")
    .select("wizard")
    .eq("user_id", user_id)
    .maybeSingle();
  if (draftErr) {
    return {
      ok: false,
      code: "draft_lookup_failed",
      message: `Failed to load onboarding draft for trust-boundary check: ${draftErr.message}`,
    };
  }
  const wizardBlob = (draft?.wizard ?? {}) as Record<string, unknown>;
  const sel = wizardBlob._anchor_selection as
    | { candidates?: Array<{ candidate_id?: string; slug?: string }> }
    | undefined;
  const knownIds = new Set<string>(
    Array.isArray(sel?.candidates)
      ? sel!.candidates
          .map((c) => c?.candidate_id)
          .filter((x): x is string => typeof x === "string" && x.length > 0)
      : [],
  );

  if (knownIds.size === 0) {
    return {
      ok: false,
      code: "no_anchor_shortlist",
      message:
        "primary_anchors submitted but no Opus-generated shortlist exists in the onboarding draft",
    };
  }

  const seenSlugs = new Set<string>();
  const sanitized: ValidatedAnchor[] = [];
  for (const a of submitted) {
    if (!knownIds.has(a.candidate_id)) {
      return {
        ok: false,
        code: "unknown_candidate_id",
        message: "Submitted anchor not in generated shortlist",
      };
    }
    const slug = sanitizeSlug(a.slug);
    if (!slug) {
      return {
        ok: false,
        code: "invalid_slug",
        message: `Anchor slug failed sanitize: ${a.slug}`,
      };
    }
    if (CANONICAL_SLUGS.has(slug)) {
      return {
        ok: false,
        code: "canonical_slug_collision",
        message: `Anchor slug '${slug}' collides with canonical-5 namespace`,
      };
    }
    if (seenSlugs.has(slug)) {
      return {
        ok: false,
        code: "duplicate_slug",
        message: `Duplicate anchor slug '${slug}' in primary_anchors`,
      };
    }
    seenSlugs.add(slug);
    sanitized.push({
      candidate_id: a.candidate_id,
      slug,
      title: sanitizeTitle(a.title) || slug,
      body_markdown: sanitizeBodyMarkdown(a.body_markdown),
    });
  }
  return { ok: true, anchors: sanitized };
}

async function seedNewBrainSlots(tenant_id: string): Promise<void> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("memory_note")
      .select("slug, body_markdown, metadata")
      .eq("tenant_id", tenant_id)
      .in("slug", NEW_BRAIN_SLUGS as unknown as string[])
      .eq("note_type", "anchor")
      .is("superseded_by", null);
    if (error) {
      console.warn(
        `[onboarding/activate] brain-slot seed read failed for ${tenant_id}: ${error.message}`,
      );
      return;
    }
    const status: Partial<Record<string, SlotStatus>> = {};
    for (const row of data ?? []) {
      const slug = (row as { slug: string | null }).slug;
      if (!slug) continue;
      status[slug] = scoreSlot(
        (row as { body_markdown: string | null }).body_markdown,
        ((row as { metadata: Record<string, unknown> | null }).metadata ??
          {}) as Record<string, unknown>,
      );
    }

    const toSeed = slugsToSeed(status);
    const nowIso = new Date().toISOString();
    for (const slug of toSeed) {
      try {
        await upsertAnchor(
          {
            tenant_id,
            slug,
            body_markdown: thinPlaceholderBody(slug),
            source: "human",
            metadata: {
              completeness: 0,
              provenance: ["onboarding_seed"],
              seed_kind: "thin_placeholder",
              scored_at: nowIso,
            },
          },
          { skipEmbedding: true },
        );
      } catch (e) {
        console.warn(
          `[onboarding/activate] brain-slot seed write failed for ${tenant_id}/${slug}: ${(e as Error).message}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `[onboarding/activate] brain-slot seed failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

export async function onboardingActivate(req: Request, res: Response): Promise<void> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message } });
    return;
  }

  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Sign in via /login first." },
    });
    return;
  }

  const gate = await requireClosedBetaGrant(verified.user_id);
  if (!gate.ok) {
    res.status(gate.status).json({
      error: { code: gate.code, message: gate.message },
    });
    return;
  }

  const claimSb = serviceClient();
  const claimKey = activationClaimKey(req.headers?.["idempotency-key"]);
  let claimToken = "";
  if (claimKey) {
    const claim = await claimStart(claimSb, verified.user_id, claimKey, { runRequired: false });
    const settled = claim.kind === "busy" ? await waitForClaimedTenant(claimSb, verified.user_id, claimKey) : null;
    if (claim.kind === "replay" || settled) {
      const replayTenant = claim.kind === "replay" ? claim.tenant_id : (settled as string);
      const { data: member } = await claimSb
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", verified.user_id)
        .eq("tenant_id", replayTenant)
        .maybeSingle();
      if (member && verified.session_id) {
        try {
          await setSessionTenant(verified.session_id, verified.user_id, replayTenant);
        } catch (e) {
          await logEvent({
            level: "warn",
            source: "onboarding.activate",
            code: "session_tenant.pin_failed",
            message: `replay session pin failed for tenant ${replayTenant}: ${(e as Error).message}`,
            tenant_id: replayTenant,
          });
        }
      }
      res.json({ ok: true, tenant_id: replayTenant, replayed: true });
      return;
    }
    if (claim.kind === "busy") {
      res.status(409).json({
        error: { code: "idempotency_in_progress", message: "Your workspace is still being set up. Try again in a moment.", retryable: true },
      });
      return;
    }
    if (claim.kind === "unavailable") {
      res.status(503).json({
        error: { code: "idempotency_unavailable", message: "Could not set up your workspace safely. Try again.", retryable: true },
      });
      return;
    }
    claimToken = claim.token;
  }
  const releaseClaim = async () => {
    if (claimKey) await releaseStartClaim(claimSb, verified.user_id, claimKey, claimToken);
  };

  let additional = body.additional === true;
  if (additional) {
    const capRejection = await checkSelfServeTenantCap(verified.user_id);
    if (capRejection) {
      let isRetry = false;
      if (capRejection.code === "multi_workspace_not_enabled") {
        try {
          const retrySlug = await resolveActivationTenantSlug({
            preferredSlug: body.slug,
            user_id: verified.user_id,
            additional: false,
          });
          isRetry = await userBelongsToTenantSlug(verified.user_id, retrySlug);
        } catch {
          isRetry = false;
        }
      }
      if (!isRetry) {
        await releaseClaim();
        res.status(403).json({ error: capRejection });
        return;
      }
      additional = false;
    }
  }

  const submittedAnchors = body.primary_anchors ?? [];
  const anchorVal = await validatePrimaryAnchors(verified.user_id, submittedAnchors);
  if (!anchorVal.ok) {
    await releaseClaim();
    res.status(422).json({
      error: { code: anchorVal.code, message: anchorVal.message },
    });
    return;
  }

  let activationSlug: string;
  try {
    activationSlug = await resolveActivationTenantSlug({
      preferredSlug: body.slug,
      user_id: verified.user_id,
      additional,
    });
  } catch (e) {
    await releaseClaim();
    res.status(500).json({
      error: { code: "slug_resolution_failed", message: (e as Error).message },
    });
    return;
  }

  let reusingOwnTenant = true;
  if (!additional) {
    try {
      reusingOwnTenant = await userBelongsToTenantSlug(verified.user_id, activationSlug);
    } catch (e) {
      await releaseClaim();
      res.status(500).json({
        error: { code: "slug_resolution_failed", message: (e as Error).message },
      });
      return;
    }
  }
  if (!reusingOwnTenant) {
    const capRejection = await checkSelfServeTenantCap(verified.user_id);
    if (capRejection) {
      await releaseClaim();
      res.status(403).json({ error: capRejection });
      return;
    }
  }

  if (!TENANT_SLUG_RE.test(activationSlug)) {
    await releaseClaim();
    res.status(500).json({
      error: {
        code: "slug_resolution_failed",
        message: `resolved slug ${activationSlug} is not a valid tenant slug`,
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(verified.access_token);

  const { company: generatedCompanyProse, ...anchorMemory } = body.memory;
  const createsWorkspace = additional || !reusingOwnTenant;
  const slot = createsWorkspace ? reserveWorkspaceSlot(req.ip) : null;
  if (createsWorkspace && !slot) {
    await releaseClaim();
    res.status(429).json({ error: { code: "workspace_limit", message: WORKSPACE_LIMIT_MESSAGE } });
    return;
  }
  const { data: tenant_id, error } = await supabase.rpc("activate_tenant_v2", {
    p_slug: activationSlug,
    p_display_name: body.display_name ?? body.slug,
    p_rar: body.rar_weekly ?? 3500,
    p_memory: anchorMemory,
    p_primary_anchors: anchorVal.anchors,
  });
  if (error) {
    slot?.release();
    await releaseClaim();
    res.status(500).json({
      error: { code: "activate_failed", message: error.message },
    });
    return;
  }

  const tenantIdStr = tenant_id as string;
  slot?.commit(tenantIdStr);
  if (claimKey) await recordStartClaim(claimSb, verified.user_id, claimKey, claimToken, { tenant_id: tenantIdStr });
  track("tenant_created", {
    tenant_id: tenantIdStr,
    user_id: verified.user_id,
    path: "wizard",
  });
  setProfile(verified.user_id, { tenant_id: tenantIdStr, tenant_slug: activationSlug });

  try {
    const { error: mintErr } = await serviceClient().rpc("mint_inbox_handle", {
      p_tenant_id: tenantIdStr,
      p_desired: body.display_name ?? body.slug,
    });
    if (mintErr) {
      await logEvent({
        level: "warn",
        source: "onboarding.activate",
        code: "inbox_handle.mint_failed",
        message: `inbox handle mint failed for tenant ${tenantIdStr}: ${mintErr.message}`,
        tenant_id: tenantIdStr,
      });
    }
  } catch {
  }

  if (createsWorkspace && isValidTimeZone(body.timezone)) {
    try {
      const { error: tzErr } = await serviceClient()
        .from("tenants")
        .update({ timezone: canonicalTz(body.timezone) })
        .eq("id", tenantIdStr);
      if (tzErr) throw new Error(tzErr.message);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "onboarding.activate",
        code: "tenant_timezone.save_failed",
        message: `timezone save failed for tenant ${tenantIdStr}: ${(e as Error).message}`,
        tenant_id: tenantIdStr,
      });
    }
  }

  if (body.additional === true) {
    invalidateCachedTenant(verified.user_id);
  }
  if (verified.session_id) {
    try {
      await setSessionTenant(verified.session_id, verified.user_id, tenantIdStr);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "onboarding.activate",
        code: "session_tenant.pin_failed",
        message: `session pin failed for tenant ${tenantIdStr}: ${(e as Error).message}`,
        tenant_id: tenantIdStr,
      });
    }
  }

  await auditTenantKind(tenantIdStr, verified.user_id, verified.email);

  await logOnboardingStep({
    tenantId: tenantIdStr,
    userId: verified.user_id,
    step: "activate",
    status: "completed",
  });

  await (async () => {
    try {
      const intent = await readBuildAppIntentFromDraft(verified.user_id);
      if (intent !== null) {
        await setTenantSetting(
          tenantIdStr,
          "build_app_intent",
          intent,
          verified.user_id,
        );
      }
      if (intent === "existing") {
        const segment = await readCompanyScaleSegmentFromDraft(verified.user_id);
        if (segment !== null) {
          await setTenantSetting(
            tenantIdStr,
            "company_scale_segment",
            segment,
            verified.user_id,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[onboarding/activate] build_app_intent / company_scale_segment persist failed for ${tenantIdStr}: ${(e as Error).message}`,
      );
    }
  })();

  await persistDraftGoal(tenantIdStr, verified.user_id);

  await persistCompanyShape(tenantIdStr, verified.user_id, body.onboarding_meta);

  await persistCompanyFacts(
    tenantIdStr,
    verified.user_id,
    body.background_memory === true ? withoutGuessedOrgName(body.onboarding_meta) : body.onboarding_meta,
  );

  const generatedStory = generatedCompanyProse?.trim();
  if (generatedStory) {
    const { writeCompanyProse } = await import("@/services/company/brief");
    const stored = await writeCompanyProse(
      tenantIdStr,
      generatedStory.length <= COMPANY_STORY_MAX
        ? generatedStory
        : generatedStory.slice(0, COMPANY_STORY_MAX),
      "provisioning",
      "onboarding wizard — generated summary",
    );
    if (!stored.stored) {
      console.warn(
        `[onboarding/activate] generated company story not stored for ${tenantIdStr}: ${stored.reason}${stored.error ? ` — ${stored.error}` : ""}`,
      );
    }
  }

  await seedCompetitorBrandsFromEnrichment(tenantIdStr, verified.user_id, body.competitors);

  autoSetCompanyCountryInBackground(tenantIdStr);

  void seedTenantBootstrap(tenantIdStr).catch((e: Error) => {
    console.warn(`[onboarding/activate] seedTenantBootstrap failed for ${tenantIdStr}: ${e.message}`);
  });

  void (async () => {
    try {
      const alreadySent = await getBoolSetting("welcome_email_sent", tenantIdStr);
      if (alreadySent) return;
      if (await enrolAndSendFirst({ tenant_id: tenantIdStr, user_id: verified.user_id })) {
        await setTenantSetting(tenantIdStr, "welcome_email_sent", true, verified.user_id);
        return;
      }
      const result = await sendWelcomeEmail({
        user_id: verified.user_id,
        displayName: body.display_name ?? body.slug,
        workspaceUrl: workspaceUrl(),
      });
      if (result.sent) {
        await setTenantSetting(
          tenantIdStr,
          "welcome_email_sent",
          true,
          verified.user_id,
        );
      }
    } catch (e) {
      console.warn(
        `[onboarding/activate] welcome email send failed for ${tenantIdStr}: ${(e as Error).message}`,
      );
    }
  })();

  void serviceClient()
    .from("onboarding_draft")
    .delete()
    .eq("user_id", verified.user_id)
    .then(({ error: delErr }) => {
      if (delErr) {
        console.warn(
          `[onboarding/activate] onboarding_draft delete failed for ${verified.user_id}: ${delErr.message}`,
        );
      }
    });

  await ensureEnrichmentTask(tenantIdStr);

  await seedNewBrainSlots(tenantIdStr);

  if (body.background_memory === true && createsWorkspace) {
    await startBackgroundMemory({
      tenantId: tenantIdStr,
      userId: verified.user_id,
      scanId: body.scan_id ?? null,
      host: activationHost(body.onboarding_meta),
      initialName: body.display_name ?? body.slug,
    });
  }

  await persistSignupAttribution(tenantIdStr, verified.user_id, body.attribution, req.query);
  await attributeTenant({ tenantId: tenantIdStr, click: body.affiliate_click, door: "activate", email: verified.email ?? null, userId: verified.user_id });

  void notifyNewTenant({
    tenant_id: tenantIdStr,
    user_id: verified.user_id,
    path: "wizard",
  });

  res.json({
    ok: true,
    tenant_id,
    memory_docs_written: Object.keys(anchorMemory).length,
    primary_anchors_written: anchorVal.anchors.length,
    ...(body.background_memory === true ? { memory: "background" as const } : {}),
  });
}

function withoutGuessedOrgName(onboardingMeta: unknown): unknown {
  if (!onboardingMeta || typeof onboardingMeta !== "object") return onboardingMeta;
  const meta = onboardingMeta as Record<string, unknown>;
  if (!meta.wizard || typeof meta.wizard !== "object") return onboardingMeta;
  const { orgName: _guessed, ...wizard } = meta.wizard as Record<string, unknown>;
  return { ...meta, wizard };
}

export const __test = {
  userBelongsToTenantSlug,
  writeTypedFactsFromWizard,
  persistCompanyFacts,
  sanitizeBodyMarkdown,
  sanitizeTitle,
  sanitizeSlug,
  validatePrimaryAnchors,
  CANONICAL_SLUGS,
  readBuildAppIntentFromDraft,
  BUILD_APP_INTENT_DRAFT_KEY,
  VALID_BUILD_APP_INTENTS,
  readCompanyScaleSegmentFromDraft,
  COMPANY_SCALE_SEGMENT_DRAFT_KEY,
  VALID_COMPANY_SCALE_SEGMENTS,
  readAutopilotGoalFromDraft,
  persistDraftGoal,
  AUTOPILOT_GOAL_DRAFT_KEY,
  readEnrichmentCompetitorNamesFromDraft,
  seedCompetitorBrandsFromEnrichment,
  ENRICHMENT_DRAFT_KEY,
  CUSTOM_BRANDS_SETTING,
  activationTenantSlugCandidates,
  resolveActivationTenantSlug,
  withoutGuessedOrgName,
  ActivateBody: Body,
};
