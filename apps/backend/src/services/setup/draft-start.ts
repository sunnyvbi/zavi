
import { enqueueAgentRun } from "@/services/agents/runner";
import { asTenantId } from "@/services/tenant-client";
import { readLatestResearchStrict, readTodaysResearch } from "@/routes/workspace/growth-intake-research";
import { researchForDraft, researchIsSettled } from "@/routes/workspace/growth-strategy-draft";
import { interviewPairs } from "@/services/growth/interview";
import { readNote } from "@/routes/workspace/growth-interview";
import { pastWorkForDraft, setupDraftKey } from "@/services/growth/setup-draft";
import { anyImportReadOpen } from "@/services/knowledge-import/run-read";

export type SetupDraftStart = { retry: true } | { status: "queued" | "already"; run_id: string | null };

export const BACKSTOP_PENDING_WAIT_MS = 15 * 60 * 1000;

export function backstopResearch<R extends { status: string; updated_at: string }>(
  latest: R | null,
  now: number,
): R | null | "wait" {
  if (!latest) return null;
  if (researchIsSettled(latest.status)) return latest;
  const touched = Date.parse(latest.updated_at);
  if (!Number.isFinite(touched) || now - touched < BACKSTOP_PENDING_WAIT_MS) return "wait";
  return null;
}

export async function startSetupDraftAttempt(
  tenant_id: string,
  next: { attempt: number; paid?: true; backstop?: true },
  noteClient: Parameters<typeof readNote>[0],
): Promise<SetupDraftStart> {
  const tid = asTenantId(tenant_id);
  let research: Awaited<ReturnType<typeof readTodaysResearch>>;
  if (next.backstop) {
    let latest: Awaited<ReturnType<typeof readLatestResearchStrict>>;
    try {
      latest = await readLatestResearchStrict(tid);
    } catch {
      return { retry: true };
    }
    const use = backstopResearch(latest, Date.now());
    if (use === "wait") return { retry: true };
    research = use;
  } else {
    research = await readTodaysResearch(tid).catch(() => null);
    if (!researchIsSettled(research?.status) && await (await import("@/routes/workspace/growth-intake-research")).isIntakeResearchEnabled()) {
      return { retry: true };
    }
  }
  if (await anyImportReadOpen(tenant_id).catch(() => true)) return { retry: true };
  const researchPayload = researchForDraft(research);
  const past_work = await pastWorkForDraft(tenant_id).catch(() => []);
  let interview: Array<{ question: string; answer: string }>;
  try {
    interview = interviewPairs((await readNote(noteClient, tenant_id, { strict: true })).metadata);
  } catch {
    return { retry: true };
  }
  const payload = {
    stage: "draft_strategy",
    origin: next.paid ? "setup_draft_paid" : "setup_draft",
    ...(interview.length ? { interview } : {}),
    ...(researchPayload ? { research: researchPayload } : {}),
    ...(past_work.length ? { past_work } : {}),
  };
  const out = await enqueueAgentRun(
    next.paid
      ? { agent_slug: "cgo", tenant_id, trigger: "a2a", payload, cron_dedupe_key: setupDraftKey(tenant_id, next.attempt) }
      : { agent_slug: "cgo", tenant_id, trigger: "a2a", payload, setup_draft_attempt: next.attempt as 1 | 2 | 3 },
  );
  return out.run_id ? { status: "queued", run_id: out.run_id } : { status: "already", run_id: null };
}
