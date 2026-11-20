
export type DraftOutcome =
  | { status: string; run_id: string | null }
  | { refused: true }
  | { insufficientCredits: true }
  | { gaveUp: true };

type DraftResponse = { status: number; ok: boolean; json: () => Promise<unknown> };

export async function runDraftStarter(
  post: () => Promise<DraftResponse>,
  opts: { attempts: number; sleep: (ms: number) => Promise<void>; cancelled?: () => boolean },
): Promise<DraftOutcome> {
  for (let i = 0; i < opts.attempts; i += 1) {
    if (opts.cancelled?.()) return { gaveUp: true };
    if (i > 0) await opts.sleep(5_000);
    if (opts.cancelled?.()) return { gaveUp: true };
    let res: DraftResponse;
    try {
      res = await post();
    } catch {
      continue;
    }
    if (res.status === 402) return { insufficientCredits: true };
    if (res.status === 409 || res.status === 403) return { refused: true };
    if (!res.ok) continue;
    const body = (await res.json().catch(() => null)) as { retry?: boolean; status?: string; run_id?: string | null } | null;
    if (!body || body.retry) continue;
    return { status: body.status ?? "queued", run_id: body.run_id ?? null };
  }
  return { gaveUp: true };
}

export const DRAFT_ATTEMPTS = 120;
