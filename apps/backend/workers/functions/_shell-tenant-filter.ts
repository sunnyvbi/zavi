export function filterOutShellTenants<T extends { tenant_id: string }>(
  rows: T[],
  shellTenantIds: Set<string>,
): { kept: T[]; excluded: number } {
  if (shellTenantIds.size === 0) return { kept: rows, excluded: 0 };
  const kept = rows.filter((r) => !shellTenantIds.has(r.tenant_id));
  return { kept, excluded: rows.length - kept.length };
}
