
export function isUniqueViolation(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return (
    msg.includes("23505") ||
    msg.includes("duplicate key value") ||
    msg.includes("unique constraint") ||
    msg.includes("decisions_strategist_origin_uq")
  );
}

export async function emitFinalCreateIdempotent(args: {
  rawEmit: (body: Record<string, unknown>) => Promise<string>;
  findExisting: (pendingDecisionId: string, tenantId: string) => Promise<{ id: string } | null>;
  body: Record<string, unknown>;
  tenant_id: string;
  pending_decision_id: string;
}): Promise<string> {
  try {
    return await args.rawEmit(args.body);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await args.findExisting(args.pending_decision_id, args.tenant_id);
      if (existing) return existing.id;
    }
    throw e;
  }
}
