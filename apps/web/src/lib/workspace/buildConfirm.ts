
export type BuildConfirm = {
  nonce: string;
  target: string;
  est_credits: number;
  est_usd: number;
  expires_at: string;
  status?: "started" | "replaced";
  run_id?: string | null;
};

export function parseBuildConfirm(raw: unknown): BuildConfirm | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.nonce !== "string" || !r.nonce) return undefined;
  if (typeof r.target !== "string") return undefined;
  if (typeof r.est_credits !== "number" || typeof r.est_usd !== "number") return undefined;
  if (typeof r.expires_at !== "string") return undefined;
  return {
    nonce: r.nonce,
    target: r.target,
    est_credits: r.est_credits,
    est_usd: r.est_usd,
    expires_at: r.expires_at,
    ...(r.status === "started" || r.status === "replaced" ? { status: r.status } : {}),
    ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}),
  };
}
