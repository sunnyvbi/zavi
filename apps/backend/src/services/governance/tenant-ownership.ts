
export type TenantOwnershipInput = {
  callerTenantId: string;
  canonicalTenantId: string;
};

export type TenantOwnershipDecision =
  | { allow: true; reason: "ok" }
  | { allow: false; reason: "tenant_mismatch" };

export function decideTenantOwnership(
  input: TenantOwnershipInput,
): TenantOwnershipDecision {
  const canonical = input.canonicalTenantId;
  const caller = input.callerTenantId;
  if (!canonical || canonical.trim().length === 0) {
    return { allow: false, reason: "tenant_mismatch" };
  }
  if (canonical === caller) {
    return { allow: true, reason: "ok" };
  }
  return { allow: false, reason: "tenant_mismatch" };
}
