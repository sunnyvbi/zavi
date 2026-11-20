
import { listNotes } from "@/services/memory";
import { sanitizeFetchedContent, xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";

export const SETUP_DRAFT_MAX_ATTEMPTS = 3;
export const SETUP_DRAFT_IN_FLIGHT = ["queued", "running", "blocked"] as const;

export function setupDraftPrefix(tenant_id: string): string {
  return `cgo:draft:${tenant_id}:setup`;
}

export function setupDraftKey(tenant_id: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`setupDraftKey: attempt ${attempt} out of range`);
  if (attempt === 1) return setupDraftPrefix(tenant_id);
  if (attempt <= SETUP_DRAFT_MAX_ATTEMPTS) return `${setupDraftPrefix(tenant_id)}:${attempt}`;
  return `${setupDraftPrefix(tenant_id)}:paid:${attempt}`;
}

export function setupDraftAttempt(tenant_id: string, key: string | null | undefined): number | null {
  if (!key) return null;
  const p = setupDraftPrefix(tenant_id);
  if (key === p) return 1;
  const m = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(?:(\\d+)|paid:(\\d+))$`).exec(key);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  if (m[1] !== undefined) return n >= 2 && n <= SETUP_DRAFT_MAX_ATTEMPTS ? n : null;
  return n > SETUP_DRAFT_MAX_ATTEMPTS ? n : null;
}

export type SetupDraftRun = {
  id: string;
  status: string;
  cron_dedupe_key: string | null;
  enqueued_at?: string | null;
  trigger?: string | null;
  enqueued_by?: string | null;
  agent_slug?: string | null;
};

export function isRefundableSetupDraft(tenant_id: string, r: SetupDraftRun): boolean {
  const a = setupDraftAttempt(tenant_id, r.cron_dedupe_key);
  return (
    r.agent_slug === "cgo" &&
    r.trigger === "a2a" &&
    (r.enqueued_by ?? null) === null &&
    a !== null &&
    a <= SETUP_DRAFT_MAX_ATTEMPTS
  );
}

export function sortSetupRuns(tenant_id: string, runs: readonly SetupDraftRun[]): SetupDraftRun[] {
  return runs
    .filter((r) => setupDraftAttempt(tenant_id, r.cron_dedupe_key) !== null)
    .sort(
      (a, b) =>
        (setupDraftAttempt(tenant_id, b.cron_dedupe_key) ?? 0) -
        (setupDraftAttempt(tenant_id, a.cron_dedupe_key) ?? 0),
    );
}

export type NextAttempt =
  | { attempt: number; paid?: true }
  | { existing: string }
  | { refused: "draft_in_flight" | "draft_done" | "free_attempts_used" };

export function nextSetupAttempt(
  tenant_id: string,
  runs: readonly SetupDraftRun[],
  hasPlan: boolean,
  retry: boolean,
  paid: boolean,
): NextAttempt {
  const latest = sortSetupRuns(tenant_id, runs)[0];
  if (!latest) return { attempt: 1 };
  if (!retry) return { existing: latest.id };
  if ((SETUP_DRAFT_IN_FLIGHT as readonly string[]).includes(latest.status)) return { refused: "draft_in_flight" };
  if (latest.status === "success" && hasPlan) return { refused: "draft_done" };
  const attempt = (setupDraftAttempt(tenant_id, latest.cron_dedupe_key) ?? SETUP_DRAFT_MAX_ATTEMPTS) + 1;
  if (attempt <= SETUP_DRAFT_MAX_ATTEMPTS) return { attempt };
  return paid ? { attempt, paid: true } : { refused: "free_attempts_used" };
}

export async function pastWorkForDraft(tenant_id: string): Promise<Array<{ fact: string }>> {
  const notes = await listNotes(tenant_id, { sources: ["document_import"], limit: 60 });
  return notes.map((n) => ({ fact: xmlEscapeContent(sanitizeFetchedContent(n.title || n.body_markdown)).slice(0, 300) }));
}
