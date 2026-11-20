
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";
import { createHash } from "node:crypto";

export const EXTERNAL_LEARN_ENV_FLAG = "ENABLE_AGENT_LEARN_EXTERNAL";

export function externalLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXTERNAL_LEARN_ENV_FLAG] === "1";
}

export const PER_FETCH_TIMEOUT_MS = 8_000;
export const MAX_FETCH_BYTES = 200 * 1024;
export const EXCERPT_MAX_CHARS = 6 * 1024;

export interface LearningSourceRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  source_url: string;
  domain_allowlist: string[] | null;
  enabled: boolean;
  fetch_cap: number | null;
  content_hash: string | null;
  etag: string | null;
  failure_count: number | null;
}

export interface LearningDb {
  readEnabledSources(): Promise<LearningSourceRow[]>;
}

export interface FetchResult {
  ok: boolean;
  status?: number;
  body?: string;
  etag?: string | null;
  reason?: "ssrf" | "not_allowlisted" | "timeout" | "status" | "empty" | "other";
}

export type GuardedFetch = (
  url: string,
  allowlist: string[],
) => Promise<FetchResult>;

export type WriteLearningNote = (input: {
  tenant_id: string;
  agent_slug: string;
  title: string;
  body_markdown: string;
  source_ref: string;
  tags: string[];
  metadata: Record<string, unknown>;
}) => Promise<{ note_id: string }>;

export type WrapSearchSnippets = (label: string, raw: string) => string;

export interface ExternalLearningDeps {
  db: LearningDb;
  fetchSource: GuardedFetch;
  writeNote: WriteLearningNote;
  wrapSearch: WrapSearchSnippets;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
}

export interface ExternalLearningStats {
  enabled: boolean;
  sources_considered: number;
  notes_written: number;
  fetch_failures: number;
  rejected_not_allowlisted: number;
  rejected_ssrf: number;
}

export function isHostAllowlisted(host: string, allowlist: string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  for (const entryRaw of allowlist) {
    if (typeof entryRaw !== "string") continue;
    const entry = entryRaw.toLowerCase().trim().replace(/^\.+|\.+$/g, "");
    if (!entry || entry === "*" || entry.includes("*")) continue;
    if (h === entry) return true;
    if (h.endsWith("." + entry)) return true;
  }
  return false;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function defaultGuardedFetch(
  url: string,
  allowlist: string[],
): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "other" };
  }
  if (!isHostAllowlisted(parsed.hostname, allowlist)) {
    return { ok: false, reason: "not_allowlisted" };
  }
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof SsrfBlockedError) return { ok: false, reason: "ssrf" };
    return { ok: false, reason: "other" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "PraxisBot/1.0 (+https://zaviagent.com)" },
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "timeout" };
  }
  if (res.status >= 300 && res.status < 400) {
    clearTimeout(timer);
    return { ok: false, reason: "status" };
  }
  if (!res.ok) {
    clearTimeout(timer);
    return { ok: false, status: res.status, reason: "status" };
  }
  let text = "";
  try {
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_FETCH_BYTES ? buf.slice(0, MAX_FETCH_BYTES) : buf;
    text = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "other" };
  }
  clearTimeout(timer);
  if (!text || text.trim().length === 0) return { ok: false, reason: "empty" };
  return { ok: true, status: res.status, body: text, etag: res.headers.get("etag") };
}

export async function runExternalLearningStep(
  deps: ExternalLearningDeps,
): Promise<ExternalLearningStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? { warn: () => {} };
  const stats: ExternalLearningStats = {
    enabled: false,
    sources_considered: 0,
    notes_written: 0,
    fetch_failures: 0,
    rejected_not_allowlisted: 0,
    rejected_ssrf: 0,
  };

  if (!externalLearningEnabled(env)) {
    return stats;
  }
  stats.enabled = true;

  let sources: LearningSourceRow[];
  try {
    sources = await deps.db.readEnabledSources();
  } catch (e) {
    logger.warn(`external-learning: source read failed: ${(e as Error).message}`);
    return stats;
  }
  if (!sources || sources.length === 0) return stats;

  for (const src of sources) {
    if (!src.enabled) continue;
    stats.sources_considered += 1;

    let fetched: FetchResult;
    try {
      fetched = await deps.fetchSource(src.source_url, src.domain_allowlist ?? []);
    } catch (e) {
      stats.fetch_failures += 1;
      logger.warn(`external-learning: fetch threw for source ${src.id}: ${(e as Error).message}`);
      continue;
    }
    if (!fetched.ok) {
      if (fetched.reason === "not_allowlisted") stats.rejected_not_allowlisted += 1;
      else if (fetched.reason === "ssrf") stats.rejected_ssrf += 1;
      else stats.fetch_failures += 1;
      continue;
    }

    const sanitized = sanitizeFetchedContent(fetched.body ?? "").slice(0, EXCERPT_MAX_CHARS);
    const wrappedBody = renderUntrustedBlock("external_learning", sanitized);
    if (!wrappedBody) {
      continue;
    }

    const fetchedAt = now().toISOString();
    const bodyHash = sha256(sanitized);

    const metadata: Record<string, unknown> = {
      provenance: {
        kind: "external_learning",
        source_id: src.id,
        source_urls: [src.source_url],
        fetched_at: fetchedAt,
        content_sha256: bodyHash,
      },
      faithfulness: {
        status: "unverified",
        grounding_checked: false,
        promotable: false,
        reason: "external_open_web_content_no_run_grounding",
      },
      trust_tier: 3,
    };

    try {
      await deps.writeNote({
        tenant_id: src.tenant_id,
        agent_slug: src.agent_slug,
        title: `External reading: ${hostOf(src.source_url)}`,
        body_markdown: wrappedBody,
        source_ref: `external-learning/${src.id}`,
        tags: [
          `agent:${src.agent_slug}`,
          "type:learning",
          "source:external_learning_distill",
          "trust:external",
        ],
        metadata,
      });
      stats.notes_written += 1;
    } catch (e) {
      stats.fetch_failures += 1;
      logger.warn(`external-learning: note write failed for source ${src.id}: ${(e as Error).message}`);
    }
  }

  return stats;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "source";
  }
}
