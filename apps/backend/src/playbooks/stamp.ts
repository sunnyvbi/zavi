
export function extractPlaybookRunId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const v = (payload as { playbook_run_id?: unknown }).playbook_run_id;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function stampPlaybookRunId(body: unknown, playbookRunId: string | undefined): unknown {
  if (!playbookRunId) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), playbook_run_id: playbookRunId };
}
