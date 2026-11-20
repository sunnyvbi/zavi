
export type ProcessRole = "all" | "api" | "worker";

export function processRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const raw = (env.PRAXIS_ROLE ?? "").trim();
  if (raw === "") return "all";
  if (raw === "api" || raw === "worker") return raw;
  throw new Error(`PRAXIS_ROLE must be "api", "worker" or unset, got "${raw}"`);
}

export function servesInngest(role: ProcessRole): boolean {
  return role !== "api";
}
