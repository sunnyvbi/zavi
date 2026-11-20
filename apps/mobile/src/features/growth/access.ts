
export type Role = "owner" | "admin" | "member" | "viewer";

export type GrowthAccess = { canEdit: boolean; canAutopilot: boolean; canDecide: boolean; readOnly: boolean };

export function growthAccess(role: Role | null): GrowthAccess {
  return {
    canEdit: role === null || role === "owner" || role === "admin",
    canAutopilot: role === null || role === "owner" || role === "admin",
    canDecide: role !== "viewer",
    readOnly: role === "viewer",
  };
}
