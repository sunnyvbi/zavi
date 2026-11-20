import { clearIdeaImages, getIdeaImages } from "./ideaImages";
import { apiFetch, ApiFetchError, apiJson } from "../../lib/api";
import { refreshSessionUntilClaim } from "../../lib/tenant-claim";
import { MAX_COMPETITORS, type Competitor, type OnboardingData } from "./types";
import { companyNameFromHost } from "./companyName";
import { deviceTimeZone } from "../agents/schedule";

export function hostOf(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .trim();
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || "company";
}

export type ScanResult = {
  status: "ok" | "skipped";
  workspace: string;
  description: string;
  audience: string;
  competitors: Competitor[];
};

type EnrichCompetitor = { name?: string; url?: string };

type EnrichResponse = {
  mode: "full";
  enrichment:
    | {
        status: "ok";
        competitors?: EnrichCompetitor[];
        description?: string;
      }
    | { status: "skipped"; reason: string }
    | null;
  debug?: { resolved_domain?: string | null };
};

const EMPTY_SCAN: ScanResult = {
  status: "skipped",
  workspace: "",
  description: "",
  audience: "",
  competitors: [],
};

export async function runSiteScan(
  website: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const host = hostOf(website);
  if (!host || !host.includes(".")) return EMPTY_SCAN;

  const guessedName = companyNameFromHost(host);
  const body = await apiJson<EnrichResponse>("/api/onboarding/enrich", {
    method: "POST",
    body: JSON.stringify({ orgName: guessedName || host, domainOverride: host, mode: "full" }),
    signal,
  });

  const e = body.enrichment;
  if (!e || e.status !== "ok") {
    return { ...EMPTY_SCAN, workspace: guessedName };
  }

  const competitors: Competitor[] = (e.competitors ?? [])
    .slice(0, MAX_COMPETITORS)
    .map((c) => ({ name: (c.name ?? "").slice(0, 80), domain: hostOf(c.url ?? "") }))
    .filter((c) => c.name || c.domain);

  return {
    status: "ok",
    workspace: guessedName,
    description: e.description ?? "",
    audience: "",
    competitors,
  };
}

type MemoryResponse = {
  ok: true;
  memory: {
    company: string;
    ops: string;
    policies: string;
    disputes: string;
    support: string;
  };
};

type ActivateResponse = { ok: true; tenant_id: string };

const EMPTY_MEMORY = { company: "", ops: "", policies: "", disputes: "", support: "" };

function freeTextFrom(data: OnboardingData): string {
  const parts: string[] = [];
  if (data.description) parts.push(data.description);
  if (data.audience) parts.push(`Who it is for: ${data.audience}`);
  if (data.website) parts.push(`Website: ${data.website}`);
  const named = data.competitors.filter((c) => c.name || c.domain);
  if (named.length > 0) {
    const list = named.map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name)).join(", ");
    parts.push(`Founder-confirmed competitors to track: ${list}`);
  }
  if (data.goal) parts.push(`Focus first: ${data.goal}`);
  return parts.join("\n\n");
}

export async function saveOnboarding(
  data: OnboardingData,
  additional = false,
  requestKey?: string,
): Promise<string | null> {
  if (data.noSite) return startBuild(data, additional, requestKey);

  const orgName = data.workspace.trim() || companyNameFromHost(hostOf(data.website)) || "My workspace";
  const slug = slugify(orgName);

  const wizard = {
    role: "",
    marketplaceShape: "other",
    stage: 0,
    orgName,
    customerId: slug,
    freeText: freeTextFrom(data),
  };

  let memory = EMPTY_MEMORY;
  try {
    const controller = new AbortController();
    const cutoff = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await apiJson<MemoryResponse>("/api/onboarding/generate-memory", {
        method: "POST",
        body: JSON.stringify({ wizard, enrichment: null }),
        signal: controller.signal,
      });
      memory = res.memory ?? EMPTY_MEMORY;
    } finally {
      clearTimeout(cutoff);
    }
  } catch {
  }

  let tenantId: string | null = null;
  const res = await apiFetch("/api/onboarding/activate", {
    method: "POST",
    timeoutMs: 90_000,
    ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
    body: JSON.stringify({
      slug,
      display_name: orgName,
      rar_weekly: 3500,
      memory,
      onboarding_meta: { wizard },
      additional,
      timezone: deviceTimeZone(),
    }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (res.ok) {
    tenantId = (parsed as ActivateResponse | undefined)?.tenant_id ?? null;
  } else if (res.status === 409 && !additional) {
    tenantId = null;
  } else {
    const err = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiFetchError(
      res.status,
      err?.code || `http_${res.status}`,
      err?.message || "Could not create your workspace.",
    );
  }

  if (tenantId) {
    clearIdeaImages();
    await refreshSessionUntilClaim(tenantId);
  }
  return tenantId;
}

export function ideaFrom(data: OnboardingData): string {
  const parts = [data.description.trim()];
  if (data.audience.trim()) parts.push(`Who it is for: ${data.audience.trim()}`);
  return parts.filter(Boolean).join("\n\n");
}

async function startBuild(data: OnboardingData, additional: boolean, requestKey?: string): Promise<string | null> {
  const post = async (companyName: string | undefined) => {
    const res = await apiFetch("/api/onboarding/build-start", {
      method: "POST",
      timeoutMs: 150_000,
      ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
      body: JSON.stringify({
        idea: ideaFrom(data),
        company_name: companyName,
        additional,
        timezone: deviceTimeZone(),
        ...(getIdeaImages().length ? { reference_images: getIdeaImages() } : {}),
      }),
    });
    const text = await res.text();
    let parsed: { tenant_id?: string | null; error?: { code?: string; message?: string } } | undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { res, parsed };
  };

  let { res, parsed } = await post(data.workspace.trim() || undefined);
  if (res.status === 400 && parsed?.error?.code === "invalid_company_name") {
    ({ res, parsed } = await post(undefined));
  }

  let tenantId: string | null = null;
  if (res.ok || res.status === 402 || (res.status === 409 && parsed?.tenant_id)) {
    tenantId = parsed?.tenant_id ?? null;
  } else if (res.status === 409 && !additional) {
    tenantId = null;
  } else {
    throw new ApiFetchError(
      res.status,
      parsed?.error?.code || `http_${res.status}`,
      parsed?.error?.message || "Could not create your workspace.",
    );
  }

  if (tenantId) {
    await refreshSessionUntilClaim(tenantId);
  }
  return tenantId;
}
